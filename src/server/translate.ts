import type { Db } from '../db/open.ts';
import { collectTerms } from '../glossary/terminology.ts';
import { checkTranslation } from '../quality/check.ts';
import { repairTranslationUnit } from '../quality/repair.ts';
import { rememberTranslations, reshape, splitByMemory } from '../ai/translationMemory.ts';
import { AgyProvider } from '../translate/agy.ts';
import { ClaudeProvider } from '../translate/claude.ts';
import { CodexProvider } from '../translate/codex.ts';
import { DEFAULT_TIMEOUT_MS, OpencodeProvider } from '../translate/opencode.ts';
import type { RequestItem, TranslationProvider } from '../translate/types.ts';
import { styleGuideFor } from './tags.ts';

/** How many times a batch is sent before it is given up on. */
const ATTEMPTS = 2;

/**
 * How many requests are out at once.
 *
 * The provider's timing varies enough that a single queue spends most of its
 * time waiting; three lanes let the quick answers keep arriving while a slow one
 * is still out.
 */
const DEFAULT_LANES = 3;

/** Gap between lanes starting, so three requests do not arrive together. */
const STAGGER_MS = 10_000;

/**
 * What one request may hold: this many strings, or this many characters of
 * source, whichever comes first.
 *
 * The response is the binding constraint, and a count alone does not bound it —
 * ten interface labels are a couple of hundred characters, ten readme paragraphs
 * are six thousand, and the second takes long enough to pass any timeout the
 * first would never approach. The provider's timing varies on top of that, which
 * is why chunks stay small: a batch that stalls then costs only the strings it
 * held and the run keeps moving.
 */
const DEFAULT_CHUNK = 10;
const DEFAULT_CHUNK_CHARS = 2_000;

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
   * When the oldest request still out went, as epoch milliseconds, or null when
   * nothing is out. opencode delivers an answer in one piece rather than
   * streaming it, so elapsed time is the only sign of life there is.
   */
  waitingSince: number | null;
  /** How many requests are out right now. */
  inFlight: number;
  /** Answers served from what the model has already said, rather than bought. */
  reused: number;
  /** How long one request may take before it is killed. */
  timeoutMs: number;
  /**
   * Which CLI and model this run is actually using.
   *
   * Reported because a run's log is not obviously one CLI's rather than the
   * other's, and "it translated with the engine I did not pick" is otherwise
   * impossible to tell from "that engine's output looks like this".
   */
  engine: Engine;
  model: string | null;
  finishedAt: string | null;
  currentChunk?: { current: number; total: number; sample?: string | undefined } | null;
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
  inFlight: 0,
  reused: 0,
  timeoutMs: 0,
  engine: 'opencode',
  model: null,
  finishedAt: null,
  currentChunk: null,
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

/** Which CLI does the translating. */
export type Engine = 'opencode' | 'agy' | 'claude' | 'codex';

export interface TranslateOptions {
  chunkSize?: number;
  /** Characters of source per request, alongside `chunkSize`. */
  chunkChars?: number;
  timeoutMs?: number;
  /** Requests out at once. One makes the run sequential. */
  lanes?: number;
  /** Gap between lanes starting. */
  staggerMs?: number;
  /** Which CLI to translate through. */
  engine?: Engine;
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
/**
 * The CLI a run will use.
 *
 * Separate and exported so which engine a request selects is a thing a test can
 * assert: constructing a provider starts no process, and the alternative is
 * finding out by watching a run's log.
 */
/**
 * Split units into requests, bounded by count and by source length.
 *
 * A unit longer than the character budget is sent on its own rather than
 * dropped: it is one string and it has to go somewhere.
 */
export function chunk<T extends { msgid: string; msgidPlural?: string | null }>(
  units: readonly T[],
  size: number,
  chars: number,
): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let length = 0;

  for (const unit of units) {
    const cost = unit.msgid.length + (unit.msgidPlural?.length ?? 0);
    if (batch.length > 0 && (batch.length >= size || length + cost > chars)) {
      batches.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(unit);
    length += cost;
  }

  if (batch.length > 0) batches.push(batch);
  return batches;
}

export function providerFor(
  options: TranslateOptions,
  onLine: (line: string) => void,
): TranslationProvider {
  if (options.engine === 'agy') {
    return new AgyProvider({
      ...(options.model ? { model: options.model } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      onLine,
    });
  }

  if (options.engine === 'claude') {
    return new ClaudeProvider({
      ...(options.model ? { model: options.model } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      onLine,
    });
  }

  if (options.engine === 'codex') {
    return new CodexProvider({
      ...(options.model ? { model: options.model } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      onLine,
    });
  }

  return new OpencodeProvider({
    ...(options.model ? { model: options.model } : {}),
    ...(options.agent ? { agent: options.agent } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    onLine,
  });
}

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
    engine: options.engine ?? 'opencode',
    model: options.model ?? null,
  };
  running = new AbortController();
  const { signal } = running;

  if (pending.length === 0) {
    progress.running = false;
    progress.finishedAt = new Date().toISOString();
    return progress;
  }

  /** Which batches are out, by number, and when each went. */
  const inFlight = new Map<number, number>();
  const oldestWait = (): void => {
    progress.inFlight = inFlight.size;
    progress.waitingSince = inFlight.size === 0 ? null : Math.min(...inFlight.values());
  };

  const record = (line: string): void => {
    progress.log.push(line.length > LOG_WIDTH ? `${line.slice(0, LOG_WIDTH)}…` : line);
    if (progress.log.length > LOG_LINES) progress.log.splice(0, progress.log.length - LOG_LINES);
  };

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

  /** One worker's turn at one batch. Errors are the batch's, not the run's. */
  const runChunk = async (
    slice: typeof pending,
    number: number,
    totalBatches: number,
    send: TranslationProvider,
    mark: (chunk: number) => void,
  ): Promise<void> => {
    const items: RequestItem[] = slice.map((unit, index) => ({
      i: index,
      s: unit.msgid,
      ...(unit.msgctxt ? { c: unit.msgctxt } : {}),
      ...(unit.msgidPlural ? { p: unit.msgidPlural } : {}),
      ...(unit.usageSurface ? { u: unit.usageSurface } : {}),
    }));

    try {
      // Whatever the model has already answered under these rules is taken out
      // first: the same string turns up in project after project.
      const { known, ask } = splitByMemory(db, items, styleGuide);
      progress.reused += known.size;

      const terms = collectTerms(db, projectId, ask.map((item) => item.s));
      mark(number);
      progress.currentChunk = {
        current: number,
        total: totalBatches,
        sample: slice[0]?.msgid ? `${slice[0].msgid.slice(0, 30)}…` : undefined,
      };
      const fresh = ask.length === 0 ? [] : await attempt(ATTEMPTS, () => {
        inFlight.set(number, Date.now());
        oldestWait();
        return send.translate(
          {
            items: ask,
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

      rememberTranslations(db, ask, fresh, styleGuide, send.name);
      // The model answered the trimmed string; the unit's own shape goes back on.
      const shaped = reshape(items, fresh);
      const answers = items.map((item) => known.get(item.i) ?? shaped.find((a) => a.i === item.i));

      db.transaction(() => {
        for (const [index, answer] of answers.entries()) {
          if (!answer) continue;
          const unit = slice[index]!;

          // Mechanically repair whitespace and echoed quote escapes before quality checks
          const repaired = repairTranslationUnit(
            unit.msgid,
            answer.t,
            unit.msgidPlural,
            answer.tp,
          );
          const transMain = repaired.translation;
          const transPlural = repaired.translationPlural;

          const failures = checkTranslation({
            ordinal: 0,
            msgid: unit.msgid,
            ...(unit.msgidPlural ? { msgidPlural: unit.msgidPlural } : {}),
            msgstr: transMain,
            ...(transPlural ? { msgstrPlural: transPlural } : {}),
          });

          // Stored so the review queue can filter and page on it in SQL.
          store.run(transMain, transPlural ?? null, failures.length > 0 ? 1 : 0, send.name, unit.id);

          if (failures.length > 0) progress.flagged += 1;
          else progress.translated += 1;
        }
      })();
    } catch (error) {
      // The units stay untranslated, so a re-run covers exactly this batch.
      // Stopping lands here too, and is not a failure to report.
      if (signal.aborted) {
        record('-- durduruldu');
        return;
      }
      record(`-- küme ${number} başarısız`);
      progress.errors.push({
        chunk: number,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      inFlight.delete(number);
      oldestWait();
      if (progress.currentChunk?.current === number) progress.currentChunk = null;
      progress.done = Math.min(progress.done + slice.length, pending.length);
    }
  };

  void (async () => {
    const batches = chunk(pending, size, options.chunkChars ?? DEFAULT_CHUNK_CHARS);

    let next = 0;
    const worker = async (lane: number): Promise<void> => {
      // Staggered, so three requests do not arrive in the same instant.
      await pause(lane * (options.staggerMs ?? STAGGER_MS), signal);

      const current = { chunk: 0 };
      const watch = (line: string): void => record(`#${current.chunk} ${line}`);
      const send = options.provider ?? providerFor(options, watch);

      while (!signal.aborted) {
        const mine = next;
        next += 1;
        if (mine >= batches.length) return;
        await runChunk(batches[mine]!, mine + 1, batches.length, send, (chunk) => (current.chunk = chunk));
      }
    };

    const lanes = Math.max(1, Math.min(options.lanes ?? DEFAULT_LANES, batches.length));
    await Promise.all(Array.from({ length: lanes }, (_, lane) => worker(lane)));

    running = null;
    progress.inFlight = 0;
    progress.waitingSince = null;
    progress.running = false;
    progress.finishedAt = new Date().toISOString();
  })();

  return progress;
}

/** Resolve after `ms`, or at once if the run has been stopped. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
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
