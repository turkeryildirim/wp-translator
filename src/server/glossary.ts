import type { Db } from '../db/open.ts';
import { sourceHash } from '../glossary/key.ts';
import { affixes } from '../text/whitespace.ts';

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
  /** How many contexts this translation has been seen under. */
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
  /** Match the query's casing exactly. Off by default. */
  caseSensitive?: boolean;
  /** Which column to search. Both, unless narrowed. */
  scope?: 'source' | 'translation';
  limit?: number;
  offset?: number;
}

export interface GlossaryPage {
  rows: GlossaryRow[];
  total: number;
}

/**
 * Search the glossary, one page at a time.
 *
 * Substring search cannot use an index, but a scan of this table is a few
 * milliseconds, so FTS5 is not pulled in. The page is chosen first and
 * decorated second: ordering needs a temp B-tree, so counts in the select list
 * of a single statement would be evaluated for every row it sorts.
 */
export function searchGlossary(db: Db, query: GlossaryQuery = {}): GlossaryPage {
  const where: string[] = [];
  const params: unknown[] = [];

  if (query.search) {
    // `instr` over a folded copy rather than `LIKE`, whose folding is ASCII only.
    const columns = searchColumns('g.source_text', 'g.translation', query.scope);
    where.push(match(columns, query.caseSensitive));
    for (const _ of columns) params.push(query.search);
  }
  if (query.tagId !== undefined) {
    where.push('g.tag_id = ?');
    params.push(query.tagId);
  }
  if (query.kind === 'memory') where.push('g.pos IS NULL');
  if (query.kind === 'term') where.push('g.pos IS NOT NULL');
  if (query.contested) {
    // Two translations of one string are two entries, so disagreement is a
    // property of the rows rather than of the links.
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
      `WITH page AS (
         SELECT g.id
           FROM glossary_entries g
           JOIN tags t ON t.id = g.tag_id
           ${clause}
          ORDER BY g.source_text, t.name, g.pos
          LIMIT ? OFFSET ?)
       SELECT g.id, g.source_text AS sourceText, g.source_plural AS sourcePlural, g.msgctxt,
              g.pos, g.note, g.translation, g.translation_plural AS translationPlural,
              g.origin, t.name AS tag,
              (SELECT count(*) FROM glossary_entry_sources l WHERE l.entry_id = g.id) AS sources,
              (SELECT count(*) FROM glossary_entry_contexts c WHERE c.entry_id = g.id) AS contexts,
              (SELECT count(*) FROM glossary_entries o
                WHERE o.source_hash = g.source_hash AND o.tag_id = g.tag_id
                  AND (o.pos IS NULL) = (g.pos IS NULL)) AS readings
         FROM page
         JOIN glossary_entries g ON g.id = page.id
         JOIN tags t ON t.id = g.tag_id
        ORDER BY g.source_text, t.name, g.pos`,
    )
    .all(...params, query.limit ?? 100, query.offset ?? 0) as GlossaryRow[];

  return { rows, total };
}

/** The columns a query looks in; narrowing keeps `Save` out of the Turkish column. */
export const searchColumns = (
  source: string,
  translation: string,
  scope?: 'source' | 'translation',
): string[] =>
  scope === 'source' ? [source] : scope === 'translation' ? [translation] : [source, translation];

/**
 * A substring test over those columns, case-folded unless the owner asked
 * otherwise. Sensitive search is plain `instr`, a byte comparison.
 */
export const match = (columns: readonly string[], sensitive?: boolean): string =>
  `(${columns
    .map((column) => (sensitive ? `instr(${column}, ?) > 0` : `instr(fold(${column}), fold(?)) > 0`))
    .join(' OR ')})`;

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

/** Which sources vouch for an entry. They all vouch for its exact wording. */
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
   * True when the source's own wording will reappear beside this one on the next
   * update, as a second reading. The owner's entry ranks above it.
   */
  sourceWordingReturns: boolean;
}

/**
 * Change an entry's translation, which also makes it the owner's. It has to be:
 * the translation is part of the key, so an edited entry matches no source's
 * wording and the sweep would delete it as unvouched.
 *
 * @param translationPlural left out to keep whatever is stored; both halves are
 * part of the key, so changing either can collide with an existing entry.
 */
export function updateEntry(
  db: Db,
  entryId: number,
  translation: string,
  translationPlural?: string | null,
): EntryUpdate {
  const before = db
    .prepare(`SELECT origin, sources FROM (${ENTRY_SELECT.trim()})`)
    .get(entryId) as { origin: string; sources: number } | undefined;
  if (!before) throw new Error(`No glossary entry with id ${entryId}.`);

  try {
    db.prepare(
      `UPDATE glossary_entries
          SET translation = ?,
              translation_plural = CASE WHEN ? THEN ? ELSE translation_plural END,
              origin = 'owner', updated_at = datetime('now')
        WHERE id = ?`,
    ).run(
      translation,
      translationPlural === undefined ? 0 : 1,
      translationPlural === undefined ? null : (translationPlural || null),
      entryId,
    );
  } catch (problem) {
    // The key is source plus translation, so this wording is already an entry.
    if (problem instanceof Error && problem.message.includes('UNIQUE')) {
      throw new Error(`Bu kaynak için "${translation}" çevirisi sözlükte zaten var.`);
    }
    throw problem;
  }

  const entry = db.prepare(ENTRY_SELECT).get(entryId) as GlossaryRow;
  return { entry, sourceWordingReturns: before.origin === 'trusted' && before.sources > 0 };
}

/** A translation-memory entry the owner writes themselves. */
export interface NewEntry {
  sourceText: string;
  sourcePlural?: string;
  translation: string;
  translationPlural?: string;
  tagId: number;
}

/**
 * Add an entry of the owner's own, as translation memory under one tag.
 *
 * Stored the way a sync stores one — the words without their surrounding
 * whitespace — so a hand-written entry and a fetched one match the same strings.
 * `msgctxt` is not part of the key and is not asked for.
 */
export function createEntry(db: Db, input: NewEntry): GlossaryRow {
  const source = affixes(input.sourceText).core;
  const sourcePlural = input.sourcePlural ? affixes(input.sourcePlural).core : undefined;
  const translation = affixes(input.translation).core;
  const translationPlural = input.translationPlural
    ? affixes(input.translationPlural).core
    : undefined;

  if (!source) throw new Error('Kaynak metin boş olamaz.');
  if (!translation) throw new Error('Çeviri boş olamaz.');
  if (translationPlural && !sourcePlural) {
    throw new Error('Çoğul çeviri için kaynağın çoğul biçimi de gerekir.');
  }
  // Both halves or neither: an entry with a plural source and no plural
  // translation fills a unit's singular and leaves its plural empty, which the
  // checks then refuse on every string it matches.
  if (sourcePlural && !translationPlural) {
    throw new Error('Çoğul kaynak için çoğul çeviri de gerekir.');
  }

  try {
    const written = db
      .prepare(
        `INSERT INTO glossary_entries
           (source_hash, source_text, source_plural, msgctxt, tag_id,
            translation, translation_plural, pos, origin)
         VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, 'owner')`,
      )
      .run(
        sourceHash(source, sourcePlural),
        source,
        sourcePlural ?? null,
        input.tagId,
        translation,
        translationPlural ?? null,
      );
    return db.prepare(ENTRY_SELECT).get(written.lastInsertRowid) as GlossaryRow;
  } catch (problem) {
    if (problem instanceof Error && problem.message.includes('UNIQUE')) {
      throw new Error(`Bu kaynak için "${translation}" çevirisi bu etikette zaten var.`);
    }
    throw problem;
  }
}

/**
 * Whether an entry is the owner's own to remove.
 *
 * Everything else came from upstream — a trusted source's row, a row a source
 * still vouches for even after the owner reworded it, or a term from the official
 * WordPress glossary, which is stored as the owner's only so the sweep spares it.
 * Removing any of those cannot stick: the next update writes it back.
 */
export const isOwnEntry = (entry: GlossaryRow): boolean =>
  entry.origin === 'owner' && entry.pos === null && entry.sources === 0;

/**
 * Remove one of the owner's own entries. Its context notes go with it.
 *
 * An entry that came from upstream is refused rather than removed and restored
 * behind the owner's back. To be rid of one of those, remove its source.
 */
export function deleteEntry(db: Db, entryId: number): { removed: number } {
  const entry = db.prepare(ENTRY_SELECT).get(entryId) as GlossaryRow | undefined;
  if (!entry) throw new Error(`No glossary entry with id ${entryId}.`);

  if (!isOwnEntry(entry)) {
    throw new Error(
      entry.pos !== null
        ? 'Bu, resmî WordPress sözlüğünden gelen bir terim. Silinemez.'
        : 'Bu girdiyi güvenilir bir kaynak taşıyor. Silinemez; kalıcı olarak çıkarmak için kaynağı listeden çıkarın.',
    );
  }

  db.prepare(`DELETE FROM glossary_entries WHERE id = ?`).run(entryId);
  return { removed: entryId };
}
