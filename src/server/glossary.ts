import type { Db } from '../db/open.ts';

export interface GlossaryRow {
  id: number;
  sourceText: string;
  sourcePlural: string | null;
  msgctxt: string | null;
  pos: string | null;
  note: string | null;
  translation: string;
  translationPlural: string | null;
  origin: 'trusted' | 'owner';
  tag: string;
  /** How many trusted sources carry this entry. */
  sources: number;
  /** How many contexts this translation has been seen under (D44). */
  contexts: number;
  /** How many translations this string has under this tag, including this one. */
  readings: number;
}

export interface GlossaryQuery {
  search?: string;
  tagId?: number;
  /** `memory` for translation memory, `term` for the terminology rows. */
  kind?: 'memory' | 'term';
  /** Only strings that have more than one translation under the same tag. */
  contested?: boolean;
  limit?: number;
  offset?: number;
}

export interface GlossaryPage {
  rows: GlossaryRow[];
  total: number;
}

/**
 * Search the glossary.
 *
 * Substring search over tens of thousands of rows is a `LIKE '%…%'`, which the
 * index on `source_text` cannot serve. At the measured size — 53 722 rows for
 * the owner's 41 sources — a scan is still a few milliseconds, so FTS5 is not
 * pulled in until it is actually needed.
 */
export function searchGlossary(db: Db, query: GlossaryQuery = {}): GlossaryPage {
  const where: string[] = [];
  const params: unknown[] = [];

  if (query.search) {
    where.push('(g.source_text LIKE ? OR g.translation LIKE ?)');
    params.push(`%${query.search}%`, `%${query.search}%`);
  }
  if (query.tagId !== undefined) {
    where.push('g.tag_id = ?');
    params.push(query.tagId);
  }
  if (query.kind === 'memory') where.push('g.pos IS NULL');
  if (query.kind === 'term') where.push('g.pos IS NOT NULL');
  if (query.contested) {
    // Disagreement is now visible in the rows themselves rather than hidden in
    // the links: two translations of one string are two entries (D44).
    where.push(
      `g.pos IS NULL AND (SELECT count(*) FROM glossary_entries o
         WHERE o.source_hash = g.source_hash AND o.tag_id = g.tag_id AND o.pos IS NULL) > 1`,
    );
  }

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const total = (
    db.prepare(`SELECT count(*) AS n FROM glossary_entries g ${clause}`).get(...params) as {
      n: number;
    }
  ).n;

  const rows = db
    .prepare(
      `SELECT g.id, g.source_text AS sourceText, g.source_plural AS sourcePlural, g.msgctxt,
              g.pos, g.note, g.translation, g.translation_plural AS translationPlural,
              g.origin, t.name AS tag,
              (SELECT count(*) FROM glossary_entry_sources l WHERE l.entry_id = g.id) AS sources,
              (SELECT count(*) FROM glossary_entry_contexts c WHERE c.entry_id = g.id) AS contexts,
              (SELECT count(*) FROM glossary_entries o
                WHERE o.source_hash = g.source_hash AND o.tag_id = g.tag_id
                  AND (o.pos IS NULL) = (g.pos IS NULL)) AS readings
         FROM glossary_entries g
         JOIN tags t ON t.id = g.tag_id
         ${clause}
        ORDER BY g.source_text, t.name, g.pos
        LIMIT ? OFFSET ?`,
    )
    .all(...params, query.limit ?? 100, query.offset ?? 0) as GlossaryRow[];

  return { rows, total };
}

export interface EntrySource {
  label: string | null;
  projectPath: string;
  rank: number;
  translation: string;
}

/** Where this translation has been seen. Informational: matching never reads it. */
export function entryContexts(db: Db, entryId: number): string[] {
  return db
    .prepare(`SELECT msgctxt FROM glossary_entry_contexts WHERE entry_id = ? ORDER BY msgctxt`)
    .all(entryId)
    .map((row) => (row as { msgctxt: string }).msgctxt);
}

/** Which sources vouch for an entry. They all vouch for its wording (D44). */
export function entrySources(db: Db, entryId: number): EntrySource[] {
  return db
    .prepare(
      `SELECT s.label, s.project_path AS projectPath, s.rank, l.translation
         FROM glossary_entry_sources l
         JOIN trusted_sources s ON s.id = l.trusted_source_id
        WHERE l.entry_id = ?
        ORDER BY s.rank, s.id`,
    )
    .all(entryId) as EntrySource[];
}

export function listTags(db: Db): { id: number; name: string; entries: number }[] {
  return db
    .prepare(
      `SELECT t.id, t.name, count(g.id) AS entries
         FROM tags t LEFT JOIN glossary_entries g ON g.tag_id = t.id
        GROUP BY t.id ORDER BY t.name`,
    )
    .all() as { id: number; name: string; entries: number }[];
}

const ENTRY_SELECT = `
  SELECT g.id, g.source_text AS sourceText, g.source_plural AS sourcePlural, g.msgctxt,
         g.pos, g.note, g.translation, g.translation_plural AS translationPlural,
         g.origin, t.name AS tag,
         (SELECT count(*) FROM glossary_entry_sources l WHERE l.entry_id = g.id) AS sources,
         (SELECT count(*) FROM glossary_entry_contexts c WHERE c.entry_id = g.id) AS contexts,
         (SELECT count(*) FROM glossary_entries o
           WHERE o.source_hash = g.source_hash AND o.tag_id = g.tag_id
             AND (o.pos IS NULL) = (g.pos IS NULL)) AS readings
    FROM glossary_entries g JOIN tags t ON t.id = g.tag_id
   WHERE g.id = ?`;

export interface EntryUpdate {
  entry: GlossaryRow;
  /**
   * True when the source's own wording will reappear beside this one.
   *
   * The translation is part of an entry's identity (D44), so editing one does
   * not overwrite what a trusted source says — the source still carries its
   * wording and puts it back on the next update, as a second reading. The
   * owner's entry ranks above it, so the edit is what gets filled in.
   */
  sourceWordingReturns: boolean;
}

/**
 * Change an entry's translation.
 *
 * The edit also makes the entry the owner's. It has to: the translation is part
 * of the key, so an edited entry no longer matches what any source vouches for,
 * and the sweep deletes a trusted entry nothing vouches for (R14) — the edit
 * would disappear on the next update.
 */
export function updateEntry(db: Db, entryId: number, translation: string): EntryUpdate {
  const before = db
    .prepare(`SELECT origin, sources FROM (${ENTRY_SELECT.trim()})`)
    .get(entryId) as { origin: string; sources: number } | undefined;
  if (!before) throw new Error(`No glossary entry with id ${entryId}.`);

  try {
    db.prepare(
      `UPDATE glossary_entries
          SET translation = ?, origin = 'owner', updated_at = datetime('now')
        WHERE id = ?`,
    ).run(translation, entryId);
  } catch (problem) {
    // The key is source plus translation, so this wording is already an entry.
    // Merging the two is not this function's job and silently discarding the
    // edit is worse, so the owner is told which one to use.
    if (problem instanceof Error && problem.message.includes('UNIQUE')) {
      throw new Error(`Bu kaynak için "${translation}" çevirisi sözlükte zaten var.`);
    }
    throw problem;
  }

  const entry = db.prepare(ENTRY_SELECT).get(entryId) as GlossaryRow;
  return { entry, sourceWordingReturns: before.origin === 'trusted' && before.sources > 0 };
}
