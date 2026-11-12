import type { Db } from '../db/open.ts';
import { sourceHash } from '../glossary/key.ts';
import { affixes } from '../text/whitespace.ts';
import { defaultTagId } from './sources.ts';

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
  isOfficial?: number;
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
  /** Specific part of speech (noun, verb, etc.) or 'memory' / 'term'. */
  pos?: string;
  /** Filter by origin: 'trusted' (locked) or 'owner' (custom/editable) */
  origin?: 'trusted' | 'owner';
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
  if (query.pos) {
    if (query.pos === 'memory') {
      where.push('g.pos IS NULL');
    } else if (query.pos === 'term') {
      where.push('g.pos IS NOT NULL');
    } else {
      where.push('g.pos = ?');
      params.push(query.pos);
    }
  } else if (query.kind === 'memory') {
    where.push('g.pos IS NULL');
  } else if (query.kind === 'term') {
    where.push('g.pos IS NOT NULL');
  }

  if (query.origin === 'trusted') {
    where.push(
      "(g.origin = 'trusted' OR g.is_official = 1 OR (SELECT count(*) FROM glossary_entry_sources l WHERE l.entry_id = g.id) > 0)",
    );
  } else if (query.origin === 'owner') {
    where.push(
      "g.origin = 'owner' AND g.is_official = 0 AND (SELECT count(*) FROM glossary_entry_sources l WHERE l.entry_id = g.id) = 0",
    );
  }
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
              g.origin, g.is_official AS isOfficial, t.name AS tag,
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
         g.origin, g.is_official AS isOfficial, t.name AS tag,
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
  note?: string | null,
  pos?: string | null,
  sourceText?: string,
): EntryUpdate {
  const before = db
    .prepare(
      `SELECT origin, sources, sourceText, sourcePlural FROM (${ENTRY_SELECT.trim()})`,
    )
    .get(entryId) as
    | { origin: string; sources: number; sourceText: string; sourcePlural: string | null }
    | undefined;
  if (!before) throw new Error(`No glossary entry with id ${entryId}.`);

  const trimmedTranslation = affixes(translation).core;
  if (!trimmedTranslation) throw new Error('Çeviri boş olamaz.');

  const trimmedSource = sourceText !== undefined ? affixes(sourceText).core : before.sourceText;
  if (!trimmedSource) throw new Error('Kaynak metin boş olamaz.');
  const newHash = sourceHash(trimmedSource, before.sourcePlural ?? undefined);

  try {
    db.prepare(
      `UPDATE glossary_entries
          SET translation = ?,
              translation_plural = CASE WHEN ? THEN ? ELSE translation_plural END,
              note = CASE WHEN ? THEN ? ELSE note END,
              pos = CASE WHEN ? THEN ? ELSE pos END,
              source_text = CASE WHEN ? THEN ? ELSE source_text END,
              source_hash = CASE WHEN ? THEN ? ELSE source_hash END,
              origin = 'owner', updated_at = datetime('now')
        WHERE id = ?`,
    ).run(
      trimmedTranslation,
      translationPlural === undefined ? 0 : 1,
      translationPlural === undefined ? null : (translationPlural || null),
      note === undefined ? 0 : 1,
      note === undefined ? null : (note || null),
      pos === undefined ? 0 : 1,
      pos === undefined ? null : (pos || null),
      sourceText === undefined ? 0 : 1,
      trimmedSource,
      sourceText === undefined ? 0 : 1,
      newHash,
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
  tagId?: number;
  pos?: string;
  note?: string;
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

  const tagId = input.tagId ? input.tagId : defaultTagId(db);
  const pos = input.pos?.trim() || null;
  const note = input.note?.trim() || null;

  try {
    const written = db
      .prepare(
        `INSERT INTO glossary_entries
           (source_hash, source_text, source_plural, msgctxt, tag_id,
            translation, translation_plural, pos, note, origin, is_official)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 'owner', 0)`,
      )
      .run(
        sourceHash(source, sourcePlural),
        source,
        sourcePlural ?? null,
        tagId,
        translation,
        translationPlural ?? null,
        pos,
        note,
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
 * Terms in the glossary (pos IS NOT NULL) can always be deleted and edited.
 * For translation memory (pos IS NULL), only entries the owner added directly
 * can be deleted; entries carrying links to trusted sources must be removed
 * by removing the source instead.
 */
export const isOwnEntry = (entry: GlossaryRow): boolean => {
  if (entry.pos === null) {
    return entry.origin === 'owner' && entry.sources === 0;
  }
  return true;
};

/**
 * Remove one entry.
 *
 * For translation memory, an entry that came from upstream is refused.
 * For terms, all entries can be removed freely.
 */
export function deleteEntry(db: Db, entryId: number): { removed: number } {
  const entry = db.prepare(ENTRY_SELECT).get(entryId) as GlossaryRow | undefined;
  if (!entry) throw new Error(`No glossary entry with id ${entryId}.`);

  if (!isOwnEntry(entry)) {
    throw new Error(
      'Bu girdiyi güvenilir bir kaynak taşıyor. Silinemez; kalıcı olarak çıkarmak için kaynağı listeden çıkarın.',
    );
  }

  db.prepare(`DELETE FROM glossary_entries WHERE id = ?`).run(entryId);
  return { removed: entryId };
}

/**
 * Delete multiple glossary terms in bulk. Only affects terms (pos IS NOT NULL).
 */
export function deleteEntries(db: Db, entryIds: number[]): { removed: number } {
  if (entryIds.length === 0) return { removed: 0 };
  const placeholders = entryIds.map(() => '?').join(',');
  const result = db
    .prepare(`DELETE FROM glossary_entries WHERE id IN (${placeholders}) AND pos IS NOT NULL`)
    .run(...entryIds);
  return { removed: result.changes };
}

const COMMON_ACTION_VERBS = new Set([
  'add', 'apply', 'activate', 'attach', 'authorize', 'back', 'backup', 'block',
  'calculate', 'cancel', 'change', 'check', 'choose', 'clean', 'clear',
  'close', 'collapse', 'complete', 'confirm', 'configure', 'connect', 'continue',
  'convert', 'copy', 'create', 'customize', 'deactivate', 'delete', 'deploy',
  'disable', 'disconnect', 'dismiss', 'download', 'duplicate', 'edit', 'empty',
  'enable', 'enter', 'erase', 'execute', 'expand', 'export', 'extract',
  'fetch', 'filter', 'find', 'fix', 'generate', 'get', 'go', 'grant',
  'hide', 'ignore', 'import', 'insert', 'install', 'invite', 'join', 'leave',
  'link', 'load', 'lock', 'log', 'login', 'logout', 'manage', 'merge',
  'modify', 'move', 'mute', 'navigate', 'notify', 'open', 'optimize',
  'parse', 'paste', 'pause', 'play', 'preview', 'print', 'process', 'publish',
  'purge', 'rebuild', 'recalculate', 'redirect', 'refresh', 'register',
  'reject', 'reload', 'remove', 'rename', 'reorder', 'repair', 'replace',
  'reply', 'resend', 'reset', 'resolve', 'restart', 'restore', 'retry',
  'return', 'revoke', 'run', 'save', 'scan', 'schedule', 'search', 'select',
  'send', 'set', 'share', 'show', 'sign', 'skip', 'sort', 'start', 'stop',
  'submit', 'subscribe', 'switch', 'sync', 'test', 'toggle', 'track',
  'translate', 'trigger', 'truncate', 'undo', 'uninstall', 'unlink', 'unlock',
  'update', 'upgrade', 'upload', 'validate', 'verify', 'view', 'warn',
]);

const COMMON_ADJECTIVES = new Set([
  'active', 'inactive', 'available', 'unavailable', 'enabled', 'disabled',
  'visible', 'hidden', 'required', 'optional', 'default', 'custom',
  'automatic', 'manual', 'current', 'previous', 'next', 'first', 'last',
  'new', 'old', 'valid', 'invalid', 'public', 'private', 'primary',
  'secondary', 'successful', 'failed', 'pending', 'complete', 'incomplete',
  'ready', 'global', 'local', 'external', 'internal', 'responsive',
  'simple', 'advanced', 'correct', 'incorrect', 'empty', 'full',
]);

/**
 * Heuristically infer part of speech for a source text and translation pair.
 */
export function inferPos(
  db: Db | undefined,
  sourceText: string,
  translation: string,
): string {
  const source = affixes(sourceText).core;
  const tr = affixes(translation).core;
  if (!source) return 'noun';

  // 1. If a term with the exact same source_hash already exists in the dictionary, reuse its pos
  if (db) {
    const hash = sourceHash(source, undefined);
    const existing = db
      .prepare(
        `SELECT pos FROM glossary_entries
          WHERE source_hash = ? AND pos IS NOT NULL
          LIMIT 1`,
      )
      .get(hash) as { pos: string } | undefined;
    if (existing?.pos) return existing.pos;
  }

  // 2. Abbreviation (URL, ID, API, SEO, SSL, etc.)
  if (/^[A-Z0-9]{2,5}$/.test(source)) {
    return 'abbreviation';
  }

  const words = source.split(/\s+/).filter(Boolean);

  // 3. Expressions: long text, punctuation, or format specifiers
  if (
    words.length >= 4 ||
    /[.?!:]$/.test(source) ||
    /%[0-9$]*[sdf]|{[^}]+}|###[a-zA-Z0-9_]+###/.test(source)
  ) {
    return 'expression';
  }

  // 4. Turkish translation ends with -mek or -mak
  if (/m[ea]k$/i.test(tr) && words.length <= 2) {
    return 'verb';
  }

  const firstLower = words[0]?.toLowerCase() ?? '';

  // 5. English action verbs
  if (COMMON_ACTION_VERBS.has(firstLower) && words.length <= 3) {
    return 'verb';
  }

  // 6. Common adjectives
  if (words.length === 1) {
    if (COMMON_ADJECTIVES.has(firstLower)) return 'adjective';
    if (
      /(able|ible|less|ous|ful)$/i.test(firstLower) &&
      !/(table|cable|title)$/i.test(firstLower)
    ) {
      return 'adjective';
    }
  }

  // 7. Expressions for 3+ words that are not action verbs
  if (words.length >= 3) {
    return 'expression';
  }

  // 8. Default to noun
  return 'noun';
}

export interface CopyResult {
  added: number;
  skipped: number;
  entries: { id: number; sourceText: string; pos: string; added: boolean }[];
}

/**
 * Copy translation memory entries into the terminology glossary without overriding existing terms.
 * When `pos` is omitted or 'auto', automatically infers part of speech per row.
 */
export function copyMemoryToTerms(
  db: Db,
  memoryEntryIds: number[],
  pos?: string,
): CopyResult {
  if (memoryEntryIds.length === 0) return { added: 0, skipped: 0, entries: [] };
  const targetTagId = defaultTagId(db);
  const fixedPos = pos && pos !== 'auto' ? pos.trim() : null;

  const selectMemory = db.prepare(
    `SELECT id, source_hash AS sourceHash, source_text AS sourceText,
            source_plural AS sourcePlural, translation, translation_plural AS translationPlural,
            note
       FROM glossary_entries
      WHERE id = ? AND pos IS NULL`,
  );

  const insert = db.prepare(
    `INSERT OR IGNORE INTO glossary_entries
       (source_hash, source_text, source_plural, msgctxt, tag_id,
        translation, translation_plural, pos, note, origin, is_official)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 'owner', 0)`,
  );

  return db.transaction(() => {
    let added = 0;
    let skipped = 0;
    const entries: { id: number; sourceText: string; pos: string; added: boolean }[] = [];

    for (const id of memoryEntryIds) {
      const row = selectMemory.get(id) as
        | {
            sourceHash: string;
            sourceText: string;
            sourcePlural: string | null;
            translation: string;
            translationPlural: string | null;
            note: string | null;
          }
        | undefined;
      if (!row) {
        skipped += 1;
        continue;
      }

      const itemPos = fixedPos ?? inferPos(db, row.sourceText, row.translation);
      const result = insert.run(
        row.sourceHash,
        row.sourceText,
        row.sourcePlural,
        targetTagId,
        row.translation,
        row.translationPlural,
        itemPos,
        row.note,
      );

      if (result.changes > 0) {
        added += 1;
        entries.push({ id, sourceText: row.sourceText, pos: itemPos, added: true });
      } else {
        skipped += 1;
        entries.push({ id, sourceText: row.sourceText, pos: itemPos, added: false });
      }
    }
    return { added, skipped, entries };
  })();
}
