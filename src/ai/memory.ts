import { createHash } from 'node:crypto';
import type { Db } from '../db/open.ts';
import { affixes } from '../text/whitespace.ts';

export { affixes, reapply, type Affixes } from '../text/whitespace.ts';

export type Kind = 'translation' | 'judgement';

/** Separates fields so two different questions cannot hash alike. */
const SEPARATOR = '\u001f';

const digest = (parts: readonly string[]): string =>
  createHash('sha256').update(parts.join(SEPARATOR)).digest('hex');

/**
 * The key for one question, over the cores rather than the exact bytes.
 *
 * Everything that distinguishes meaning is kept; only the surrounding
 * whitespace is factored out, and that is restored from the string being
 * answered rather than from the one that was asked about.
 */
export const questionKey = (parts: readonly string[]): string =>
  digest(parts.map((part) => affixes(part).core));

/** The rules an answer was given under. Changing them retires the answers. */
export const rulesKey = (styleGuide: string): string => digest([styleGuide]);

export interface Remembered<T> {
  answer: T;
  model: string | null;
}

/** What the model said last time, or null if it was never asked this. */
export function recall<T>(
  db: Db,
  kind: Kind,
  keyHash: string,
  rulesHash: string,
): Remembered<T> | null {
  const row = db
    .prepare(
      `SELECT id, answer, model FROM ai_memory
        WHERE kind = ? AND key_hash = ? AND rules_hash = ?`,
    )
    .get(kind, keyHash, rulesHash) as
    | { id: number; answer: string; model: string | null }
    | undefined;
  if (!row) return null;

  db.prepare(`UPDATE ai_memory SET uses = uses + 1, used_at = datetime('now') WHERE id = ?`).run(
    row.id,
  );

  try {
    return { answer: JSON.parse(row.answer) as T, model: row.model };
  } catch {
    // A row we cannot read is worse than none: drop it rather than fail the run.
    db.prepare(`DELETE FROM ai_memory WHERE id = ?`).run(row.id);
    return null;
  }
}

export interface Remember {
  kind: Kind;
  keyHash: string;
  rulesHash: string;
  sourceText: string;
  question: unknown;
  answer: unknown;
  model?: string | null;
}

/** Keep an answer for next time. A repeat replaces what was there. */
export function remember(db: Db, entry: Remember): void {
  db.prepare(
    `INSERT INTO ai_memory (kind, key_hash, rules_hash, source_text, question, answer, model)
     VALUES (@kind, @keyHash, @rulesHash, @sourceText, @question, @answer, @model)
     ON CONFLICT (kind, key_hash, rules_hash) DO UPDATE SET
       answer = excluded.answer, model = excluded.model, created_at = datetime('now')`,
  ).run({
    kind: entry.kind,
    keyHash: entry.keyHash,
    rulesHash: entry.rulesHash,
    sourceText: entry.sourceText,
    question: JSON.stringify(entry.question),
    answer: JSON.stringify(entry.answer),
    model: entry.model ?? null,
  });
}

export interface MemoryCounts {
  translation: number;
  judgement: number;
  /** How many answers have been served from memory rather than bought again. */
  reuses: number;
}

export function memoryCounts(db: Db): MemoryCounts {
  const row = db
    .prepare(
      `SELECT sum(kind = 'translation') AS translation,
              sum(kind = 'judgement') AS judgement,
              ifnull(sum(uses), 0) AS reuses
         FROM ai_memory`,
    )
    .get() as Record<string, number | null>;

  return {
    translation: row.translation ?? 0,
    judgement: row.judgement ?? 0,
    reuses: row.reuses ?? 0,
  };
}
