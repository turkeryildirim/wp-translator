import type { Db } from '../db/open.ts';
import { collectTerms } from '../glossary/terminology.ts';
import { checkTranslation } from '../quality/check.ts';
import { DEFAULT_TIMEOUT_MS, OpencodeProvider } from '../translate/opencode.ts';
import type { RequestItem, TranslationProvider } from '../translate/types.ts';
import { styleGuideFor } from './tags.ts';

/** How many times a chunk is sent before it is given up on. */
const ATTEMPTS = 2;

/**
 * Strings per request.
 *
 * The response is the binding constraint, not the request, and the provider's
 * timing varies far more than the count does — the same batch size can answer
 * in seconds or stall past any timeout. Small batches do not make that go away;
 * they make it cheap, because a batch that stalls costs only the strings it
 * held and the run keeps moving.
 */
const DEFAULT_CHUNK = 10;

export interface TranslateProgress {
  running: boolean;
  projectId: number | null;
  done: number;
  total: number;
  /** Returned by the model and stored, pending review. */
  translated: number;
  /** Returned but refused by the quality checks; stored anyway, still in review. */
  flagged: number;
  errors: { chunk: number; message: string }[];
  /** The tail of what the provider wrote, newest last, for watching a run. */
  log: string[];
  /**
   * When the request in flight went out, as epoch milliseconds, or null between
   * requests. opencode delivers an answer in one piece rather than streaming
   * it, so elapsed time is the only sign of life there is.
   */
  waitingSince: number | null;
  /** How long one request may take before it is killed. */
  timeoutMs: number;
  finishedAt: string | null;
}

/** Enough to see what a request is doing without the payload becoming the page. */
const LOG_LINES = 200;
const LOG_WIDTH = 300;

const idle = (): TranslateProgress => ({
  running: false,
  projectId: null,
  done: 0,
  total: 0,
  translated: 0,
  flagged: 0,
  errors: [],
  log: [],
  waitingSince: null,
  timeoutMs: 0,
  finishedAt: null,
});

let progress: TranslateProgress = idle();
let running: AbortController | null = null;

export const translateProgress = (): TranslateProgress => progress;

/**
 * Stop the run after the request in flight.
 *
 * Aborting kills the provider's process, so the chunk it was on is lost and
 * stays untranslated — which is what a failed chunk already does, and is why a
 * later run picks up exactly what is left.
 */
export function stopTranslation(): TranslateProgress {
  running?.abort();
  return progress;
}

/**
 * Which units to send. `waiting` re-translates what nobody has approved, which
 * is how to try again after changing the style guide; `all` overwrites
 * everything, including what came from the service.
 */
export type TranslateScope = 'untranslated' | 'waiting' | 'selected' | 'all';

export interface TranslateOptions {
  chunkSize?: number;
  timeoutMs?: number;
  model?: string;
  agent?: string;
  provider?: TranslationProvider;
  scope?: TranslateScope;
  /** Required by `selected`, ignored otherwise. */
  ids?: readonly number[];
}

/**
 * Translate a project's units, by default everything the glossary could not
 * fill. Runs in the background and the panel polls it. A chunk is the retry
 * unit: one that fails leaves its units untranslated, so a re-run resumes.
 */
export function startTranslation(
  db: Db,
  projectId: number,
  options: TranslateOptions = {},
): TranslateProgress {
  if (progress.running) return progress;

  const scope = options.scope ?? 'untranslated';
  const ids = options.ids ?? [];
  const pending =
    scope === 'selected' && ids.length === 0
      ? []
      : (db
          .prepare(
            `SELECT id, msgid, msgid_plural AS msgidPlural, msgctxt, usage_surface AS usageSurface
               FROM translation_units
              WHERE project_id = ? AND ${scopeClause(scope, ids.length)}
              ORDER BY ordinal`,
          )
          .all(projectId, ...(scope === 'selected' ? ids : [])) as {
            id: number;
            msgid: string;
            msgidPlural: string | null;
            msgctxt: string | null;
            usageSurface: string | null;
          }[]);

  progress = {
    ...idle(),
    running: true,
    projectId,
    total: pending.length,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  running = new AbortController();
  const { signal } = running;

  if (pending.length === 0) {
    progress.running = false;
    progress.finishedAt = new Date().toISOString();
    return progress;
  }

  const record = (line: string): void => {
    progress.log.push(line.length > LOG_WIDTH ? `${line.slice(0, LOG_WIDTH)}…` : line);
    if (progress.log.length > LOG_LINES) progress.log.splice(0, progress.log.length - LOG_LINES);
  };

  const provider =
    options.provider ??
    new OpencodeProvider({
      ...(options.model ? { model: options.model } : {}),
      ...(options.agent ? { agent: options.agent } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      onLine: record,
    });

  const project = db
    .prepare(`SELECT name, description, readme FROM projects WHERE id = ?`)
    .get(projectId) as { name: string | null; description: string | null; readme: string | null };

  const styleGuide = styleGuideFor(db, projectId);
  const size = options.chunkSize ?? DEFAULT_CHUNK;

  const store = db.prepare(
    `UPDATE translation_units
        SET msgstr = ?, msgstr_plural = ?, state = 'review', provenance = 'ai', blocked = ?,
            provider = ?, updated_at = datetime('now')
      WHERE id = ?`,
  );

  void (async () => {
    for (let start = 0; start < pending.length; start += size) {
      if (signal.aborted) break;
      const slice = pending.slice(start, start + size);
      const items: RequestItem[] = slice.map((unit, index) => ({
        i: index,
        s: unit.msgid,
        ...(unit.msgctxt ? { c: unit.msgctxt } : {}),
        ...(unit.msgidPlural ? { p: unit.msgidPlural } : {}),
        ...(unit.usageSurface ? { u: unit.usageSurface } : {}),
      }));

      try {
        const terms = collectTerms(db, projectId, items.map((item) => item.s));
        // A stalled request is the common failure, and it costs the chunk. One
        // retry turns that into a delay rather than fifty lost strings.
        const answers = await attempt(ATTEMPTS, () => {
          progress.waitingSince = Date.now();
          return provider.translate(
            {
              items,
              context: {
                styleGuide,
                terms,
                project: {
                  ...(project.name ? { name: project.name } : {}),
                  ...(project.description ? { description: project.description } : {}),
                  ...(project.readme ? { readme: project.readme } : {}),
                },
              },
            },
            signal,
          );
        });
        progress.waitingSince = null;

        db.transaction(() => {
          for (const [index, answer] of answers.entries()) {
            const unit = slice[index]!;

            const failures = checkTranslation({
              ordinal: 0,
              msgid: unit.msgid,
              ...(unit.msgidPlural ? { msgidPlural: unit.msgidPlural } : {}),
              msgstr: answer.t,
              ...(answer.tp ? { msgstrPlural: answer.tp } : {}),
            });

            // Stored so the review queue can filter and page on it in SQL.
            store.run(answer.t, answer.tp ?? null, failures.length > 0 ? 1 : 0, provider.name, unit.id);

            if (failures.length > 0) progress.flagged += 1;
            else progress.translated += 1;
          }
        })();
      } catch (error) {
        // The units stay untranslated, so a re-run covers exactly this chunk.
        // Stopping lands here too, and is not a failure to report.
        if (signal.aborted) {
          record('-- durduruldu');
          break;
        }
        const chunk = Math.floor(start / size) + 1;
        record(`-- küme ${chunk} başarısız`);
        progress.errors.push({
          chunk,
          message: error instanceof Error ? error.message : String(error),
        });
      }

      progress.waitingSince = null;
      progress.done = Math.min(start + size, pending.length);
    }

    running = null;
    progress.running = false;
    progress.finishedAt = new Date().toISOString();
  })();

  return progress;
}

/** Run `work` until it succeeds or the attempts run out, reporting the last error. */
async function attempt<T>(times: number, work: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let n = 0; n < times; n += 1) {
    try {
      return await work();
    } catch (error) {
      last = error;
      // Retrying an aborted call would restart what the owner just stopped.
      if (error instanceof Error && error.name === 'AbortError') break;
    }
  }
  throw last;
}

/** The `WHERE` a scope stands for. `all` needs none. */
function scopeClause(scope: TranslateScope, idCount: number): string {
  switch (scope) {
    case 'untranslated':
      return `state = 'untranslated'`;
    case 'waiting':
      return `state = 'review'`;
    case 'selected':
      return `id IN (${Array.from({ length: idCount }, () => '?').join(', ')})`;
    case 'all':
      return '1 = 1';
  }
}
