import type { Db } from '../db/open.ts';
import { defaultTagId } from './sources.ts';
import { inferPos, match, searchColumns } from './glossary.ts';
import type { Term } from '../glossary/terminology.ts';
import { checkTranslation, type CheckFailure } from '../quality/check.ts';

export type UnitState = 'untranslated' | 'review' | 'ok';
export type Provenance = 'glossary' | 'ai' | 'human';

export interface UnitRow {
  id: number;
  msgid: string;
  msgidPlural: string | null;
  msgctxt: string | null;
  msgstr: string | null;
  msgstrPlural: string | null;
  state: UnitState;
  provenance: Provenance | null;
  /** Quality-check failures. Approval is blocked while this is non-empty. */
  failures: CheckFailure[];
  /** Other translations the glossary holds for this string, best first. */
  candidates: Candidate[];
  /** True when the string carries placeholders, HTML, plurals, or is long. */
  structured: boolean;
}

export interface Candidate {
  translation: string;
  tag: string;
}

/**
 * What the queue is showing. Named for what the owner is looking for rather than
 * for the column it reads: `blocked` and `upstream` are not states.
 */
export type QueueView =
  | 'all'
  | 'untranslated'
  | 'waiting'
  | 'translated'
  | 'blocked'
  | 'upstream';

export interface UnitFilter {
  view?: QueueView;
  search?: string;
  /** Match the query's casing exactly. Off by default. */
  caseSensitive?: boolean;
  /** Which column to search. Both, unless narrowed. */
  scope?: 'source' | 'translation';
  limit?: number;
  offset?: number;
}

export interface UnitPage {
  rows: UnitRow[];
  /** Units matching the filter, not just the ones on this page. */
  total: number;
  /** How many the filter would show for each view, for the buttons. */
  counts: Record<QueueView, number>;
}

export interface ProjectSummary {
  id: number;
  name: string | null;
  projectPath: string;
  subProject: string | null;
  /** The project's page on translate.wordpress.org, as the owner gave it. */
  translateUrl: string;
  total: number;
  ok: number;
  review: number;
  untranslated: number;
}

const STRUCTURE = /%(?:\d+\$)?(?:ll|l|z|h)?[@sdifuxXgGc]|%%|<\/?[a-zA-Z][^<>]*>|\{[a-zA-Z_][\w.]*\}/;

export function listProjects(db: Db): ProjectSummary[] {
  return db
    .prepare(
      `SELECT p.id, p.name, p.project_path AS projectPath, p.sub_project AS subProject, p.translate_url AS translateUrl,
              count(u.id) AS total,
              sum(u.state = 'ok') AS ok,
              sum(u.state = 'review') AS review,
              sum(u.state = 'untranslated') AS untranslated
         FROM projects p LEFT JOIN translation_units u ON u.project_id = p.id
        GROUP BY p.id
        ORDER BY p.name, p.project_path`,
    )
    .all() as ProjectSummary[];
}

/** The `WHERE` each view stands for, over `translation_units u`. */
const VIEW: Record<QueueView, string> = {
  all: '1 = 1',
  untranslated: `u.state = 'untranslated'`,
  waiting: `u.state = 'review'`,
  translated: `u.state = 'ok'`,
  blocked: 'u.blocked = 1',
  // Translated by the service before the owner opened the project.
  upstream: `u.upstream = 'current' AND u.provenance IS NULL`,
};

/**
 * One page of the review queue, in catalogue order.
 *
 * Filtering and paging happen in SQL and only the page's rows are enriched, so
 * the cost does not grow with the project. The views replace sorting by
 * urgency: a filter says "show me the blocked ones" more directly.
 */
export function listUnits(db: Db, projectId: number, filter: UnitFilter = {}): UnitPage {
  const where: string[] = ['u.project_id = ?', VIEW[filter.view ?? 'all']];
  const params: unknown[] = [projectId];

  if (filter.search) {
    // Folded in the application; SQLite's own folding stops at ASCII.
    const columns = searchColumns('u.msgid', `ifnull(u.msgstr, '')`, filter.scope);
    where.push(match(columns, filter.caseSensitive));
    for (const _ of columns) params.push(filter.search);
  }

  const clause = where.join(' AND ');
  const total = (
    db
      .prepare(`SELECT count(*) AS n FROM translation_units u WHERE ${clause}`)
      .get(...params) as { n: number }
  ).n;

  const rows = db
    .prepare(
      `WITH page AS (
         SELECT u.id FROM translation_units u
          WHERE ${clause}
          ORDER BY u.ordinal
          LIMIT ? OFFSET ?)
       SELECT u.id, u.msgid, u.msgid_plural AS msgidPlural, u.msgctxt,
              u.msgstr, u.msgstr_plural AS msgstrPlural, u.state, u.provenance,
              u.upstream, u.blocked
         FROM page JOIN translation_units u ON u.id = page.id
        ORDER BY u.ordinal`,
    )
    .all(...params, filter.limit ?? 100, filter.offset ?? 0) as UnitSource[];

  const overrides = overridesByUnit(db, projectId);
  return {
    rows: rows.map((row) => enrich(db, projectId, row, overrides.get(row.id))),
    total,
    counts: countViews(db, projectId),
  };
}

type UnitSource = Omit<UnitRow, 'failures' | 'candidates' | 'structured'> & { blocked: number };

/** One pass over the project, so the buttons can carry their own numbers. */
function countViews(db: Db, projectId: number): Record<QueueView, number> {
  const row = db
    .prepare(
      `SELECT count(*) AS all_,
              sum(u.state = 'untranslated') AS untranslated,
              sum(u.state = 'review') AS waiting,
              sum(u.state = 'ok') AS translated,
              sum(u.blocked = 1) AS blocked,
              sum(u.upstream = 'current' AND u.provenance IS NULL) AS upstream
         FROM translation_units u WHERE u.project_id = ?`,
    )
    .get(projectId) as Record<string, number | null>;

  return {
    all: row.all_ ?? 0,
    untranslated: row.untranslated ?? 0,
    waiting: row.waiting ?? 0,
    translated: row.translated ?? 0,
    blocked: row.blocked ?? 0,
    upstream: row.upstream ?? 0,
  };
}

/**
 * What a bulk action applies to. A filter travels as a filter rather than as the
 * ids it stands for, so approving a whole view costs one request.
 */
export type BulkTarget = { ids: readonly number[] } | { filter: UnitFilter };

/** The `WHERE` a target stands for, over `translation_units u`. */
function targetClause(
  projectId: number,
  target: BulkTarget,
): { clause: string; params: unknown[] } {
  const params: unknown[] = [projectId];

  if ('ids' in target) {
    const holes = target.ids.map(() => '?').join(', ');
    params.push(...target.ids);
    // `1 = 0` rather than an empty `IN ()`, which SQLite will not parse.
    return {
      clause: target.ids.length > 0 ? `u.project_id = ? AND u.id IN (${holes})` : '1 = 0',
      params: target.ids.length > 0 ? params : [],
    };
  }

  const { filter } = target;
  const where = ['u.project_id = ?', VIEW[filter.view ?? 'all']];
  if (filter.search) {
    const columns = searchColumns('u.msgid', `ifnull(u.msgstr, '')`, filter.scope);
    where.push(match(columns, filter.caseSensitive));
    for (const _ of columns) params.push(filter.search);
  }
  return { clause: where.join(' AND '), params };
}

/** Every unit a filter matches, for the actions that cannot be one `UPDATE`. */
export function unitIdsFor(db: Db, projectId: number, filter: UnitFilter): number[] {
  const { clause, params } = targetClause(projectId, { filter });
  return db
    .prepare(`SELECT u.id FROM translation_units u WHERE ${clause}`)
    .all(...params)
    .map((row) => (row as { id: number }).id);
}

/**
 * Approve or clear a set of units. Approving skips whatever the checks blocked;
 * clearing empties the unit and returns it to `untranslated`, so it exports
 * nothing and the next translation run picks it up.
 */
export function bulkSetState(
  db: Db,
  projectId: number,
  target: BulkTarget,
  action: 'approve' | 'clear',
): { changed: number; skipped: number } {
  const { clause, params } = targetClause(projectId, target);

  return db.transaction(() => {
    const matched = (
      db
        .prepare(`SELECT count(*) AS n FROM translation_units u WHERE ${clause}`)
        .get(...params) as { n: number }
    ).n;

    const changed =
      action === 'approve'
        ? db
            .prepare(
              `UPDATE translation_units AS u
                  SET state = 'ok', updated_at = datetime('now')
                WHERE ${clause} AND u.blocked = 0 AND u.msgstr IS NOT NULL AND u.msgstr <> ''`,
            )
            .run(...params).changes
        : db
            .prepare(
              `UPDATE translation_units AS u
                  SET msgstr = NULL, msgstr_plural = NULL, state = 'untranslated',
                      provenance = NULL, glossary_entry_id = NULL, blocked = 0,
                      updated_at = datetime('now')
                WHERE ${clause}`,
            )
            .run(...params).changes;

    return { changed, skipped: matched - changed };
  })();
}

export interface AddUnitsToGlossaryResult {
  added: number;
  skipped: number;
  empty: number;
  entries: { id: number; sourceText: string; pos: string; added: boolean }[];
}

/**
 * Add translation units to the glossary (terminology, pos IS NOT NULL).
 * Does not overwrite existing glossary terms (INSERT OR IGNORE).
 */
export function addUnitsToGlossary(
  db: Db,
  projectId: number,
  target: BulkTarget,
  options: {
    pos?: string | undefined;
    translation?: string | undefined;
    translationPlural?: string | undefined;
  } = {},
): AddUnitsToGlossaryResult {
  const { clause, params } = targetClause(projectId, target);

  const projectTagRow = db
    .prepare(`SELECT tag_id FROM project_tags WHERE project_id = ? LIMIT 1`)
    .get(projectId) as { tag_id: number } | undefined;
  const tagId = projectTagRow?.tag_id ?? defaultTagId(db);

  const fixedPos = options.pos && options.pos !== 'auto' ? options.pos.trim() : null;

  const units = db
    .prepare(
      `SELECT u.id, u.source_hash AS sourceHash, u.msgid AS sourceText,
              u.msgid_plural AS sourcePlural, u.msgstr AS translation,
              u.msgstr_plural AS translationPlural
         FROM translation_units u
        WHERE ${clause}`,
    )
    .all(...params) as {
      id: number;
      sourceHash: string;
      sourceText: string;
      sourcePlural: string | null;
      translation: string | null;
      translationPlural: string | null;
    }[];

  const insert = db.prepare(
    `INSERT OR IGNORE INTO glossary_entries
       (source_hash, source_text, source_plural, msgctxt, tag_id,
        translation, translation_plural, pos, note, origin, is_official)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, 'owner', 0)`,
  );

  return db.transaction(() => {
    let added = 0;
    let skipped = 0;
    let empty = 0;
    const entries: { id: number; sourceText: string; pos: string; added: boolean }[] = [];

    for (const unit of units) {
      const translation =
        options.translation !== undefined && units.length === 1
          ? options.translation.trim()
          : (unit.translation ?? '').trim();
      const translationPlural =
        options.translationPlural !== undefined && units.length === 1
          ? options.translationPlural.trim()
          : (unit.translationPlural ?? '').trim();

      if (!translation) {
        empty += 1;
        continue;
      }

      const itemPos = fixedPos ?? inferPos(db, unit.sourceText, translation);
      const res = insert.run(
        unit.sourceHash,
        unit.sourceText,
        unit.sourcePlural,
        tagId,
        translation,
        translationPlural || null,
        itemPos,
      );

      if (res.changes > 0) {
        added += 1;
        entries.push({ id: unit.id, sourceText: unit.sourceText, pos: itemPos, added: true });
      } else {
        skipped += 1;
        entries.push({ id: unit.id, sourceText: unit.sourceText, pos: itemPos, added: false });
      }
    }

    return { added, skipped, empty, entries };
  })();
}

export interface TmSuggestion {
  source: string;
  translation: string;
  translationPlural: string | null;
  similarity: number;
  tag?: string;
}

export interface GlossarySuggestion {
  id: number;
  source: string;
  translation: string;
  translationPlural: string | null;
  pos: string | null;
  note: string | null;
  tag: string | null;
  isOfficial: boolean;
}

/** What the detail panel shows for one unit. */
export interface UnitDetail {
  msgid: string;
  refs: string | null;
  extractedComments: string | null;
  usageSurface: string | null;
  suggestions: TmSuggestion[];
  terms: Term[];
  glossaryTerms: GlossarySuggestion[];
}

function calculateSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 0;
  const maxL = Math.max(la, lb);
  const minL = Math.min(la, lb);
  if (minL / maxL < 0.65) return 0;

  let prev = new Int32Array(lb + 1);
  let curr = new Int32Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    const codeA = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = codeA === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1,
        curr[j - 1]! + 1,
        prev[j - 1]! + cost,
      );
    }
    const temp = prev;
    prev = curr;
    curr = temp;
  }
  return Math.max(0, (maxL - prev[lb]!) / maxL);
}

export function findTmSuggestions(db: Db, projectId: number, msgid: string): TmSuggestion[] {
  const normTarget = msgid.trim().toLowerCase();
  const cleanTarget = normTarget.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '');

  const suggestions: TmSuggestion[] = [];
  const seen = new Set<string>();

  // 1. Exact matches for the whole string (%100)
  const exactRows = db
    .prepare(
      `SELECT g.source_text AS source, g.translation, g.translation_plural AS translationPlural,
              t.name AS tag
         FROM glossary_entries g
         JOIN tags t ON t.id = g.tag_id
        WHERE g.source_text = ? AND g.pos IS NULL
          AND g.tag_id IN (SELECT tag_id FROM project_tags WHERE project_id = ?)
        GROUP BY g.translation, ifnull(g.translation_plural, '')
        ORDER BY (g.origin = 'owner') DESC, g.id ASC`,
    )
    .all(msgid, projectId) as { source: string; translation: string; translationPlural: string | null; tag: string }[];

  for (const r of exactRows) {
    const key = `${r.translation}\u0000${r.translationPlural ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      suggestions.push({
        source: r.source,
        translation: r.translation,
        translationPlural: r.translationPlural,
        similarity: 100,
        tag: r.tag,
      });
    }
  }

  // 2. Fuzzy matches (>= 85% similarity) for the whole string
  if (msgid.length >= 3) {
    const minLen = Math.floor(msgid.length * 0.70);
    const maxLen = Math.ceil(msgid.length / 0.70);

    const words = (msgid.match(/[A-Za-z0-9]+/g) || [])
      .filter((w) => w.length >= 3)
      .sort((a, b) => b.length - a.length)
      .slice(0, 3);

    let query = `
      SELECT g.source_text AS source, g.translation, g.translation_plural AS translationPlural,
             t.name AS tag
        FROM glossary_entries g
        JOIN tags t ON t.id = g.tag_id
       WHERE g.pos IS NULL
         AND g.tag_id IN (SELECT tag_id FROM project_tags WHERE project_id = ?)
         AND length(g.source_text) BETWEEN ? AND ?
    `;
    const params: (number | string)[] = [projectId, minLen, maxLen];

    if (words.length > 0) {
      const likeClauses = words.map(() => 'g.source_text LIKE ?').join(' OR ');
      query += ` AND (${likeClauses})`;
      for (const w of words) params.push(`%${w}%`);
    }
    query += ' LIMIT 400';

    const fuzzyCandidates = db.prepare(query).all(...params) as {
      source: string;
      translation: string;
      translationPlural: string | null;
      tag: string;
    }[];

    for (const r of fuzzyCandidates) {
      const normSource = r.source.trim().toLowerCase();
      const cleanSource = normSource.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '');

      let sim = calculateSimilarity(normTarget, normSource);
      if (cleanTarget === cleanSource && sim < 0.90) {
        sim = 0.92;
      }
      const pct = Math.round(sim * 100);
      if (pct >= 85) {
        const key = `${r.translation}\u0000${r.translationPlural ?? ''}`;
        if (!seen.has(key)) {
          seen.add(key);
          suggestions.push({
            source: r.source,
            translation: r.translation,
            translationPlural: r.translationPlural,
            similarity: pct,
            tag: r.tag,
          });
        }
      }
    }
  }

  suggestions.sort((a, b) => b.similarity - a.similarity);
  return suggestions.slice(0, 8);
}

export function findGlossarySuggestions(db: Db, projectId: number, msgid: string): GlossarySuggestion[] {
  const norm = msgid.trim();
  const clean = norm.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '');

  const query = `
    SELECT g.id, g.source_text AS source, g.translation,
           g.translation_plural AS translationPlural,
           g.pos, g.note, t.name AS tag, g.is_official AS isOfficial
      FROM glossary_entries g
      LEFT JOIN tags t ON t.id = g.tag_id
     WHERE g.pos IS NOT NULL
       AND (
         g.source_text = ?
         OR fold(g.source_text) = fold(?)
         ${clean && clean !== norm ? 'OR fold(g.source_text) = fold(?)' : ''}
       )
       AND (
         g.tag_id IS NULL
         OR (SELECT count(*) FROM project_tags WHERE project_id = ?) = 0
         OR g.tag_id IN (SELECT tag_id FROM project_tags WHERE project_id = ?)
         OR g.is_official = 1
       )
     ORDER BY (g.source_text = ?) DESC, (g.is_official = 1) DESC, g.id ASC
  `;

  const params: (string | number)[] = [
    norm,
    norm,
    ...(clean && clean !== norm ? [clean] : []),
    projectId,
    projectId,
    norm,
  ];

  const rows = db.prepare(query).all(...params) as {
    id: number;
    source: string;
    translation: string;
    translationPlural: string | null;
    pos: string | null;
    note: string | null;
    tag: string | null;
    isOfficial: number;
  }[];

  return rows.map((r) => ({
    ...r,
    isOfficial: r.isOfficial === 1,
  }));
}

export function unitDetail(db: Db, unitId: number): UnitDetail {
  const row = db
    .prepare(
      `SELECT project_id AS projectId, msgid, refs, extracted_comments AS extractedComments,
              usage_surface AS usageSurface
         FROM translation_units WHERE id = ?`,
    )
    .get(unitId) as
    | { projectId: number; msgid: string; refs: string | null; extractedComments: string | null; usageSurface: string | null }
    | undefined;

  if (!row) throw new Error(`No translation unit with id ${unitId}.`);

  return {
    msgid: row.msgid,
    refs: row.refs,
    extractedComments: row.extractedComments,
    usageSurface: row.usageSurface,
    suggestions: findTmSuggestions(db, row.projectId, row.msgid),
    terms: [],
    glossaryTerms: findGlossarySuggestions(db, row.projectId, row.msgid),
  };
}

export interface SaveResult {
  unit: UnitRow;
  /** Set when the quality checks refused the translation. */
  blocked?: CheckFailure[];
}

/**
 * Store a translation, and settle the unit only if asked to.
 *
 * A failing translation is stored so the work is not lost, but the unit stays in
 * `review` until it passes the checks or the owner records an exception.
 *
 * @param approve `false` keeps the unit waiting, which is what saving an edit
 * without deciding on it means. Passing the checks is not the same as being
 * approved.
 */
export function saveUnit(
  db: Db,
  unitId: number,
  edit: { msgstr?: string; msgstrPlural?: string } = {},
  approve = false,
): SaveResult {
  const current = db
    .prepare(
      `SELECT project_id AS projectId, msgid, msgid_plural AS msgidPlural,
              msgstr, msgstr_plural AS msgstrPlural
         FROM translation_units WHERE id = ?`,
    )
    .get(unitId) as
    | { projectId: number; msgid: string; msgidPlural: string | null; msgstr: string | null; msgstrPlural: string | null }
    | undefined;

  if (!current) throw new Error(`No translation unit with id ${unitId}.`);

  const msgstr = edit.msgstr ?? current.msgstr ?? '';
  const msgstrPlural = edit.msgstrPlural ?? current.msgstrPlural ?? undefined;

  const failures = checkTranslation({
    ordinal: 0,
    msgid: current.msgid,
    ...(current.msgidPlural ? { msgidPlural: current.msgidPlural } : {}),
    msgstr,
    ...(msgstrPlural ? { msgstrPlural } : {}),
  });

  const overridden = new Set(
    (db.prepare(`SELECT rule FROM qa_exceptions WHERE unit_id = ?`).all(unitId) as { rule: string }[])
      .map((row) => row.rule),
  );
  const blocking = failures.filter((failure) => !overridden.has(failure.rule));

  // An empty translation is not a translation: the unit goes back to
  // untranslated, so it exports nothing and the next run picks it up. This is
  // what rejecting a string does.
  if (msgstr === '') {
    db.prepare(
      `UPDATE translation_units
          SET msgstr = NULL, msgstr_plural = NULL, state = 'untranslated',
              provenance = NULL, glossary_entry_id = NULL, blocked = 0,
              updated_at = datetime('now')
        WHERE id = ?`,
    ).run(unitId);
    return { unit: getUnit(db, current.projectId, unitId) };
  }

  db.prepare(
    `UPDATE translation_units
        SET msgstr = ?, msgstr_plural = ?, state = ?, blocked = ?,
            provenance = CASE WHEN ? THEN 'human' ELSE provenance END,
            updated_at = datetime('now')
      WHERE id = ?`,
  ).run(
    msgstr,
    msgstrPlural ?? null,
    blocking.length === 0 && approve ? 'ok' : 'review',
    blocking.length === 0 ? 0 : 1,
    edit.msgstr !== undefined ? 1 : 0,
    unitId,
  );

  const unit = getUnit(db, current.projectId, unitId);
  return blocking.length === 0 ? { unit } : { unit, blocked: blocking };
}

export interface ReplaceResult {
  /** Units in scope whose translation contains the text. */
  matched: number;
  /** Of those, how many were written. Zero on a preview. */
  changed: number;
  /** Of those written, how many the quality checks now refuse. */
  blocked: number;
}

/**
 * Replace text inside translations, across whatever the queue is currently showing.
 *
 * Literal and case-sensitive: a replacement is applied to thousands of rows at
 * once and matching loosely is how the wrong ones get rewritten. Only `msgstr` and
 * its plural are touched — never the source — and every unit written goes back to
 * `review` exactly as editing one by hand does, because the text is no longer the
 * one that was approved.
 *
 * @param preview counts without writing, so the size of the change is known first.
 */
function turkishRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const trFolded = escaped.replace(/[iİıI]/g, '[iİıI]');
  return new RegExp(trFolded, 'gui');
}

export function replaceInTranslations(
  db: Db,
  projectId: number,
  target: BulkTarget,
  find: string,
  replace: string,
  preview = false,
  caseSensitive = true,
): ReplaceResult {
  if (find === '') throw new Error('Aranacak metin boş olamaz.');

  const regex = caseSensitive ? null : turkishRegex(find);
  const doReplace = (text: string): string =>
    caseSensitive ? text.replaceAll(find, replace) : text.replace(regex!, replace);

  const { clause, params } = targetClause(projectId, target);
  const rows = db
    .prepare(
      `SELECT u.id, u.msgid, u.msgid_plural AS msgidPlural, u.msgstr,
              u.msgstr_plural AS msgstrPlural
         FROM translation_units u
        WHERE ${clause} AND u.msgstr IS NOT NULL AND u.msgstr <> ''`,
    )
    .all(...params) as {
    id: number;
    msgid: string;
    msgidPlural: string | null;
    msgstr: string;
    msgstrPlural: string | null;
  }[];

  const write = db.prepare(
    `UPDATE translation_units
        SET msgstr = ?, msgstr_plural = ?, state = 'review', blocked = ?,
            provenance = 'human', updated_at = datetime('now')
      WHERE id = ?`,
  );
  const exceptions = db.prepare(`SELECT rule FROM qa_exceptions WHERE unit_id = ?`);

  return db.transaction((): ReplaceResult => {
    let matched = 0;
    let changed = 0;
    let blocked = 0;

    for (const row of rows) {
      const msgstr = doReplace(row.msgstr);
      const msgstrPlural = row.msgstrPlural ? doReplace(row.msgstrPlural) : null;
      if (msgstr === row.msgstr && msgstrPlural === row.msgstrPlural) continue;

      matched += 1;
      if (preview) continue;

      const overridden = new Set(
        (exceptions.all(row.id) as { rule: string }[]).map((exception) => exception.rule),
      );
      const blocking = checkTranslation({
        ordinal: 0,
        msgid: row.msgid,
        ...(row.msgidPlural ? { msgidPlural: row.msgidPlural } : {}),
        msgstr,
        ...(msgstrPlural ? { msgstrPlural } : {}),
      }).filter((failure) => !overridden.has(failure.rule));

      write.run(msgstr, msgstrPlural, blocking.length === 0 ? 0 : 1, row.id);
      changed += 1;
      if (blocking.length > 0) blocked += 1;
    }

    return { matched, changed, blocked };
  })();
}

/** One unit, enriched the same way the queue enriches its page. */
export function getUnit(db: Db, projectId: number, unitId: number): UnitRow {
  const row = db
    .prepare(
      `SELECT u.id, u.msgid, u.msgid_plural AS msgidPlural, u.msgctxt,
              u.msgstr, u.msgstr_plural AS msgstrPlural, u.state, u.provenance,
              u.upstream, u.blocked
         FROM translation_units u WHERE u.id = ?`,
    )
    .get(unitId) as UnitSource | undefined;
  if (!row) throw new Error(`No translation unit with id ${unitId}.`);

  return enrich(db, projectId, row, overridesByUnit(db, projectId).get(unitId));
}

/** Record a deliberate exception so a blocked string can be approved. */
export function overrideCheck(db: Db, unitId: number, rule: string, reason: string): void {
  db.prepare(
    `INSERT INTO qa_exceptions (unit_id, rule, reason) VALUES (?, ?, ?)
     ON CONFLICT (unit_id, rule) DO UPDATE SET reason = excluded.reason`,
  ).run(unitId, rule, reason);
}

/** All recorded exceptions for a project in one query, rather than one per row. */
function overridesByUnit(db: Db, projectId: number): Map<number, Set<string>> {
  const rows = db
    .prepare(
      `SELECT e.unit_id AS unitId, e.rule
         FROM qa_exceptions e
         JOIN translation_units u ON u.id = e.unit_id
        WHERE u.project_id = ?`,
    )
    .all(projectId) as { unitId: number; rule: string }[];

  const byUnit = new Map<number, Set<string>>();
  for (const row of rows) {
    const rules = byUnit.get(row.unitId) ?? byUnit.set(row.unitId, new Set()).get(row.unitId)!;
    rules.add(row.rule);
  }
  return byUnit;
}

function enrich(
  db: Db,
  projectId: number,
  row: UnitSource,
  overridden: Set<string> = new Set(),
): UnitRow {
  const failures =
    row.msgstr === null
      ? []
      : checkTranslation({
          ordinal: 0,
          msgid: row.msgid,
          ...(row.msgidPlural ? { msgidPlural: row.msgidPlural } : {}),
          msgstr: row.msgstr,
          ...(row.msgstrPlural ? { msgstrPlural: row.msgstrPlural } : {}),
        });

  return {
    ...row,
    failures: failures.filter((failure) => !overridden.has(failure.rule)),
    // Offered whenever the glossary filled the unit, so the alternatives to
    // what it chose stay one keystroke away.
    candidates:
      row.provenance === 'glossary' ? candidatesFor(db, projectId, row.msgid) : [],
    structured:
      STRUCTURE.test(row.msgid) || row.msgidPlural !== null || row.msgid.length > 80,
  };
}

/**
 * The glossary's translations of this string, ordered the way `applyGlossary`
 * ranks them, so the first is the one already filled in. A single result means
 * there is nothing to choose, so none is offered.
 */
function candidatesFor(db: Db, projectId: number, msgid: string): Candidate[] {
  const rows = db
    .prepare(
      `SELECT g.translation, t.name AS tag
         FROM glossary_entries g
         JOIN tags t ON t.id = g.tag_id
         LEFT JOIN glossary_entry_sources s ON s.entry_id = g.id
         LEFT JOIN trusted_sources ts ON ts.id = s.trusted_source_id
        WHERE g.source_text = ? AND g.pos IS NULL
          AND g.tag_id IN (SELECT tag_id FROM project_tags WHERE project_id = ?)
        GROUP BY g.id
        ORDER BY (g.origin = 'owner') DESC,
                 count(DISTINCT s.trusted_source_id) DESC,
                 ifnull(min(ts.rank), 2147483647) ASC,
                 g.id ASC`,
    )
    .all(msgid, projectId) as Candidate[];

  // Same wording under two tags is one candidate: there is nothing to pick.
  const seen = new Set<string>();
  const distinct = rows.filter((row) => !seen.has(row.translation) && seen.add(row.translation));

  return distinct.length > 1 ? distinct : [];
}

