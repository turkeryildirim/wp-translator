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
}

export interface GlossaryQuery {
  search?: string;
  tagId?: number;
  /** `memory` for translation memory, `term` for the terminology rows. */
  kind?: 'memory' | 'term';
  /** Only entries several sources disagree about, or that have several readings. */
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
    where.push(
      `(SELECT count(DISTINCT translation) FROM glossary_entry_sources l
         WHERE l.entry_id = g.id) > 1`,
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
              (SELECT count(*) FROM glossary_entry_sources l WHERE l.entry_id = g.id) AS sources
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

/** Which sources vouch for an entry, and with what — the disagreements live here. */
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
         (SELECT count(*) FROM glossary_entry_sources l WHERE l.entry_id = g.id) AS sources
    FROM glossary_entries g JOIN tags t ON t.id = g.tag_id
   WHERE g.id = ?`;

export interface EntryUpdate {
  entry: GlossaryRow;
  /**
   * True when the edit will not survive the next sync.
   *
   * A trusted entry can be edited, but the trusted source wins when it next runs
   * (D11), so the panel says so rather than letting the change quietly revert.
   */
  overwrittenOnNextSync: boolean;
}

export function updateEntry(db: Db, entryId: number, translation: string): EntryUpdate {
  const changed = db
    .prepare(`UPDATE glossary_entries SET translation = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(translation, entryId).changes;

  if (changed === 0 && !db.prepare(`SELECT 1 FROM glossary_entries WHERE id = ?`).get(entryId)) {
    throw new Error(`No glossary entry with id ${entryId}.`);
  }

  const entry = db.prepare(ENTRY_SELECT).get(entryId) as GlossaryRow;
  return { entry, overwrittenOnNextSync: entry.origin === 'trusted' && entry.sources > 0 };
}
