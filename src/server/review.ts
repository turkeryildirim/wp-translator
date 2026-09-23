import type { Db } from '../db/open.ts';
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

export interface UnitFilter {
  state?: UnitState;
  /** Only units whose approval is blocked. */
  blocked?: boolean;
  /** Only units waiting on a candidate choice. */
  ambiguous?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
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

/**
 * The review queue.
 *
 * Default order is what the design asks for: blocked strings first, then rows
 * waiting on a candidate choice, then the rest. Reviewing 3 818 strings in
 * source order spends the owner's attention on the easy ones.
 */
export function listUnits(db: Db, projectId: number, filter: UnitFilter = {}): UnitRow[] {
  const where: string[] = ['u.project_id = ?'];
  const params: unknown[] = [projectId];

  if (filter.state) {
    where.push('u.state = ?');
    params.push(filter.state);
  }
  if (filter.search) {
    where.push('(u.msgid LIKE ? OR ifnull(u.msgstr, \'\') LIKE ?)');
    params.push(`%${filter.search}%`, `%${filter.search}%`);
  }

  const rows = db
    .prepare(
      `SELECT u.id, u.msgid, u.msgid_plural AS msgidPlural, u.msgctxt,
              u.msgstr, u.msgstr_plural AS msgstrPlural, u.state, u.provenance
         FROM translation_units u
        WHERE ${where.join(' AND ')}
        ORDER BY u.ordinal`,
    )
    .all(...params) as Omit<UnitRow, 'failures' | 'candidates' | 'structured'>[];

  const overrides = overridesByUnit(db, projectId);
  const enriched = rows.map((row) => enrich(db, projectId, row, overrides.get(row.id)));

  const filtered = enriched.filter((row) => {
    if (filter.blocked && row.failures.length === 0) return false;
    if (filter.ambiguous && row.candidates.length === 0) return false;
    return true;
  });

  filtered.sort(byUrgency);

  const offset = filter.offset ?? 0;
  return filtered.slice(offset, offset + (filter.limit ?? filtered.length));
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
        SET msgstr = ?, msgstr_plural = ?, state = ?,
            provenance = CASE WHEN ? THEN 'human' ELSE provenance END,
            updated_at = datetime('now')
      WHERE id = ?`,
  ).run(
    msgstr,
    msgstrPlural ?? null,
    blocking.length === 0 ? 'ok' : 'review',
    edit.msgstr !== undefined ? 1 : 0,
    unitId,
  );

  const unit = listUnits(db, current.projectId).find((row) => row.id === unitId)!;
  return blocking.length === 0 ? { unit } : { unit, blocked: blocking };
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
  row: Omit<UnitRow, 'failures' | 'candidates' | 'structured'>,
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
    candidates:
      row.state === 'review' && row.provenance === 'glossary'
        ? candidatesFor(db, projectId, row.msgid, row.msgctxt)
        : [],
    structured:
      STRUCTURE.test(row.msgid) || row.msgidPlural !== null || row.msgid.length > 80,
  };
}

/** Recomputed on demand rather than stored — derivable from the glossary at any time. */
function candidatesFor(
  db: Db,
  projectId: number,
  msgid: string,
  msgctxt: string | null,
): Candidate[] {
  return db
    .prepare(
      `SELECT g.translation, t.name AS tag
         FROM glossary_entries g
         JOIN tags t ON t.id = g.tag_id
        WHERE g.source_text = ? AND ifnull(g.msgctxt, '') = ? AND g.pos IS NULL
          AND g.tag_id IN (SELECT tag_id FROM project_tags WHERE project_id = ?)
        ORDER BY t.name`,
    )
    .all(msgid, msgctxt ?? '', projectId) as Candidate[];
}

function byUrgency(a: UnitRow, b: UnitRow): number {
  const rank = (row: UnitRow) =>
    row.failures.length > 0 ? 0 : row.candidates.length > 0 ? 1 : row.state === 'review' ? 2 : 3;
  return rank(a) - rank(b);
}
