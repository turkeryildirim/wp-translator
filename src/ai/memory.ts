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

export interface MemoryRow {
  id: number;
  kind: Kind;
  keyHash: string;
  sourceText: string;
  answer: unknown;
  model: string | null;
  uses: number;
  usedAt: string | null;
  createdAt: string;
}

export interface MemoryListResult {
  total: number;
  entries: MemoryRow[];
}

export function listMemoryEntries(
  db: Db,
  options?: {
    kind?: Kind | undefined;
    search?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  },
): MemoryListResult {
  const kind = options?.kind;
  const search = options?.search?.trim();
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;

  const whereClauses: string[] = [];
  const params: unknown[] = [];

  if (kind) {
    whereClauses.push('kind = ?');
    params.push(kind);
  }

  if (search) {
    whereClauses.push('(source_text LIKE ? OR answer LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const totalRow = db.prepare(`SELECT count(*) AS cnt FROM ai_memory ${whereSql}`).get(...params) as { cnt: number };
  const total = totalRow?.cnt ?? 0;

  const rows = db.prepare(`
    SELECT id, kind, key_hash AS keyHash, source_text AS sourceText, answer, model, uses,
           used_at AS usedAt, created_at AS createdAt
      FROM ai_memory
     ${whereSql}
     ORDER BY id DESC
     LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as Array<{
    id: number;
    kind: Kind;
    keyHash: string;
    sourceText: string;
    answer: string;
    model: string | null;
    uses: number;
    usedAt: string | null;
    createdAt: string;
  }>;

  const entries: MemoryRow[] = rows.map((r) => {
    let parsed: unknown = r.answer;
    try {
      parsed = JSON.parse(r.answer);
    } catch {}
    return {
      id: r.id,
      kind: r.kind,
      keyHash: r.keyHash,
      sourceText: r.sourceText,
      answer: parsed,
      model: r.model,
      uses: r.uses,
      usedAt: r.usedAt,
      createdAt: r.createdAt,
    };
  });

  return { total, entries };
}

export function deleteMemoryEntry(db: Db, id: number): boolean {
  const info = db.prepare('DELETE FROM ai_memory WHERE id = ?').run(id);
  return info.changes > 0;
}

export function deleteMemoryEntries(db: Db, ids: number[]): number {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const info = db.prepare(`DELETE FROM ai_memory WHERE id IN (${placeholders})`).run(...ids);
  return info.changes;
}

export function clearMemory(db: Db, kind?: Kind): number {
  if (kind) {
    const info = db.prepare('DELETE FROM ai_memory WHERE kind = ?').run(kind);
    return info.changes;
  }
  const info = db.prepare('DELETE FROM ai_memory').run();
  return info.changes;
}

