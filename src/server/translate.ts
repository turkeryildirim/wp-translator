import type { Db } from '../db/open.ts';
import { collectTerms } from '../glossary/terminology.ts';
import { checkTranslation } from '../quality/check.ts';
import { OpencodeProvider } from '../translate/opencode.ts';
import type { RequestItem, TranslationProvider } from '../translate/types.ts';
import { styleGuideFor } from './tags.ts';

/**
 * Strings per request.
 *
 * The **response** is the binding constraint, not the request: WooCommerce's
 * whole catalogue would need ~292 000 output tokens in one turn, and a truncated
 * reply is worse than a refused one because it reads as a result (R18). Measured,
 * 500 strings is ~12 500 output tokens, so 50 leaves generous room for the small
 * output caps free models tend to have.
 */
const DEFAULT_CHUNK = 50;

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
  finishedAt: string | null;
}

const idle = (): TranslateProgress => ({
  running: false,
  projectId: null,
  done: 0,
  total: 0,
  translated: 0,
  flagged: 0,
  errors: [],
  finishedAt: null,
});

let progress: TranslateProgress = idle();

export const translateProgress = (): TranslateProgress => progress;

/**
 * Which units to send.
 *
 * `untranslated` is the ordinary run. `waiting` re-translates what the model
 * already produced but nobody approved — the way to try again after changing
 * the style guide. `selected` takes the rows the owner picked in the queue.
 * `all` overwrites everything, including translations that came from the
 * service, which is why the panel confirms it first.
 */
export type TranslateScope = 'untranslated' | 'waiting' | 'selected' | 'all';

export interface TranslateOptions {
  chunkSize?: number;
  model?: string;
  agent?: string;
  provider?: TranslationProvider;
  scope?: TranslateScope;
  /** Required by `selected`, ignored otherwise. */
  ids?: readonly number[];
}

/**
 * Translate what the owner asked for — by default, everything the glossary
 * could not fill.
 *
 * Runs in the background and the panel polls it: a project of a few thousand
 * strings is tens of requests, each taking the better part of a minute.
 *
 * A chunk is the retry unit. A chunk that fails leaves its units untranslated
 * rather than half-stored, so re-running picks up exactly what is left and the
 * run as a whole is resumable.
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

  progress = { ...idle(), running: true, projectId, total: pending.length };
  if (pending.length === 0) {
    progress.running = false;
    progress.finishedAt = new Date().toISOString();
    return progress;
  }

  const provider =
    options.provider ??
    new OpencodeProvider({
      ...(options.model ? { model: options.model } : {}),
      ...(options.agent ? { agent: options.agent } : {}),
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
        const answers = await provider.translate({
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
        });

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

            // Stored, not recomputed later: the review queue filters and pages
            // on this column rather than running the checks over every row.
            store.run(answer.t, answer.tp ?? null, failures.length > 0 ? 1 : 0, provider.name, unit.id);

            if (failures.length > 0) progress.flagged += 1;
            else progress.translated += 1;
          }
        })();
      } catch (error) {
        // The units stay untranslated, so a re-run covers exactly this chunk.
        progress.errors.push({
          chunk: Math.floor(start / size) + 1,
          message: error instanceof Error ? error.message : String(error),
        });
      }

      progress.done = Math.min(start + size, pending.length);
    }

    progress.running = false;
    progress.finishedAt = new Date().toISOString();
  })();

  return progress;
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
