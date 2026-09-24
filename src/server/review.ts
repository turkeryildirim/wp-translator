import type { Db } from '../db/open.ts';
import { match, searchColumns } from './glossary.ts';
import { collectTerms, type Term } from '../glossary/terminology.ts';
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
  /** Competing glossary translations when the project's tags disagree (D37). */
  candidates: Candidate[];
  /** True when the string carries placeholders, HTML, plurals, or is long. */
  structured: boolean;
}

export interface Candidate {
  translation: string;
  tag: string;
}

/**
 * What the queue is showing.
 *
 * Named for what the owner is looking for rather than for the column it reads,
 * because two of them are not a state: `fuzzy` is a translation that came from
 * the service and the checks distrust, and `blocked` is any translation the
 * checks distrust whoever wrote it.
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
  total: number;
  ok: number;
  review: number;
  untranslated: number;
}

const STRUCTURE = /%(?:\d+\$)?(?:ll|l|z|h)?[@sdifuxXgGc]|%%|<\/?[a-zA-Z][^<>]*>|\{[a-zA-Z_][\w.]*\}/;

export function listProjects(db: Db): ProjectSummary[] {
  return db
    .prepare(
      `SELECT p.id, p.name, p.project_path AS projectPath,
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
  // Translated by the service before the owner ever opened the project. These
  // are the ones a GTE is reviewing rather than writing.
  upstream: `u.upstream = 'current' AND u.provenance IS NULL`,
};

/**
 * The review queue, one page of it.
 *
 * Filtering and paging happen in SQL, and only the page's rows are enriched.
 * They used to be loaded whole — every row, with the quality checks and a
 * glossary lookup run on each — and then sliced in JS, which is the same
 * mistake that cost the glossary browser 40 s a page (R30). A project of 3 116
 * strings paid that on every keystroke.
 *
 * Rows come in catalogue order rather than by urgency. Urgency ordering needs
 * the whole set in hand, and the views replace what it was for: a filter says
 * "show me the blocked ones" better than a sort that floats them.
 */
export function listUnits(db: Db, projectId: number, filter: UnitFilter = {}): UnitPage {
  const where: string[] = ['u.project_id = ?', VIEW[filter.view ?? 'all']];
  const params: unknown[] = [projectId];

  if (filter.search) {
    // Folded in the application: SQLite's own folding stops at ASCII, so a
    // Turkish query missed every capitalised translation (R31).
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
 * Approve or reject every unit a filter matches.
 *
 * Done in SQL rather than by sending thousands of ids to the browser and back:
 * "show me the untranslated ones and approve them all" is one statement, and a
 * project runs to thousands of strings.
 *
 * Approving skips what the checks blocked — bulk approval is the only way a
 * few thousand strings are survivable, and also how one mistake becomes a few
 * thousand. Rejecting empties the unit and returns it to `untranslated`, so it
 * exports nothing and the next translation run picks it up.
 */
export function bulkSetState(
  db: Db,
  projectId: number,
  filter: UnitFilter,
  action: 'approve' | 'reject',
): { changed: number; skipped: number } {
  const where = ['u.project_id = ?', VIEW[filter.view ?? 'all']];
  const params: unknown[] = [projectId];

  if (filter.search) {
    const columns = searchColumns('u.msgid', `ifnull(u.msgstr, '')`, filter.scope);
    where.push(match(columns, filter.caseSensitive));
    for (const _ of columns) params.push(filter.search);
  }
  const clause = where.join(' AND ');

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

/** What the detail panel shows for one unit. */
export interface UnitDetail {
  refs: string | null;
  extractedComments: string | null;
  usageSurface: string | null;
  terms: Term[];
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
    refs: row.refs,
    extractedComments: row.extractedComments,
    usageSurface: row.usageSurface,
    terms: collectTerms(db, row.projectId, [row.msgid]),
  };
}

export interface SaveResult {
  unit: UnitRow;
  /** Set when the quality checks refused the translation. */
  blocked?: CheckFailure[];
}

/**
 * Approve a unit, optionally replacing its translation first.
 *
 * Editing *is* rejecting — there is no reject state (D22). The quality checks
 * are blocking: a failing translation is stored so the work is not lost, but the
 * unit stays in `review` until it passes or the owner records an exception.
 */
export function saveUnit(
  db: Db,
  unitId: number,
  edit: { msgstr?: string; msgstrPlural?: string } = {},
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

  db.prepare(
    `UPDATE translation_units
        SET msgstr = ?, msgstr_plural = ?, state = ?, blocked = ?,
            provenance = CASE WHEN ? THEN 'human' ELSE provenance END,
            updated_at = datetime('now')
      WHERE id = ?`,
  ).run(
    msgstr,
    msgstrPlural ?? null,
    blocking.length === 0 ? 'ok' : 'review',
    blocking.length === 0 ? 0 : 1,
    edit.msgstr !== undefined ? 1 : 0,
    unitId,
  );

  // One row, not the project: this used to call `listUnits` and search its
  // result, which loaded and enriched every string in the catalogue to answer
  // "what does this one look like now".
  const unit = getUnit(db, current.projectId, unitId);
  return blocking.length === 0 ? { unit } : { unit, blocked: blocking };
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
    // Offered whenever the glossary filled the unit, not only when it gave up:
    // the fill takes the best-supported translation and the others stay one
    // keystroke away (D44).
    candidates:
      row.provenance === 'glossary' ? candidatesFor(db, projectId, row.msgid) : [],
    structured:
      STRUCTURE.test(row.msgid) || row.msgidPlural !== null || row.msgid.length > 80,
  };
}

/**
 * Recomputed on demand rather than stored — derivable from the glossary at any
 * time. Ordered the way `applyGlossary` ranks them, so the first is the one
 * already in the box and the rest read as the alternatives to it. A single
 * result means there is nothing to choose, so none is offered.
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

