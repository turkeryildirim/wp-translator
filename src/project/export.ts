import type { Db } from '../db/open.ts';
import { serializePo } from '../po/serialize.ts';
import type { Catalogue, TranslationUnit } from '../po/types.ts';

export interface ExportSummary {
  exported: number;
  /** Units not yet settled — `untranslated` or awaiting review. */
  withheld: number;
}

export interface ExportResult extends ExportSummary {
  po: Buffer;
}

interface UnitRow {
  ordinal: number;
  msgid: string;
  msgid_plural: string | null;
  msgctxt: string | null;
  refs: string | null;
  extracted_comments: string | null;
  msgstr: string | null;
  msgstr_plural: string | null;
}

/**
 * Export a project as PO for import into GlotPress.
 *
 * Only `ok` units are written. GlotPress reads `#, fuzzy` as fuzzy status,
 * skips an entry whose `msgstr` is empty and ignores `#~` obsolete entries, so
 * anything unsettled is withheld rather than sent in a state that would be
 * silently reinterpreted.
 *
 * `msgctxt` travels untouched. GlotPress matches an incoming entry by singular +
 * plural + context, so an entry that loses its context matches no original and
 * its translation is dropped on import (R2) — which is why it is carried through
 * even though nothing here ever reads it.
 */
export function exportProject(db: Db, projectId: number): ExportResult {
  const project = db
    .prepare(`SELECT po_headers AS headers FROM projects WHERE id = ?`)
    .get(projectId) as { headers: string | null } | undefined;

  if (!project) throw new Error(`No project with id ${projectId}.`);

  const rows = db
    .prepare(
      `SELECT ordinal, msgid, msgid_plural, msgctxt, refs, extracted_comments,
              msgstr, msgstr_plural
         FROM translation_units
        WHERE project_id = ? AND state = 'ok' AND msgstr IS NOT NULL AND msgstr <> ''
        ORDER BY ordinal`,
    )
    .all(projectId) as UnitRow[];

  const withheld = (
    db
      .prepare(
        `SELECT count(*) AS n FROM translation_units
          WHERE project_id = ? AND NOT (state = 'ok' AND msgstr IS NOT NULL AND msgstr <> '')`,
      )
      .get(projectId) as { n: number }
  ).n;

  const catalogue: Catalogue = {
    headers: project.headers ? (JSON.parse(project.headers) as Record<string, string>) : {},
    units: rows.map(toUnit),
  };

  return { po: serializePo(catalogue), exported: rows.length, withheld };
}

function toUnit(row: UnitRow): TranslationUnit {
  const unit: TranslationUnit = { ordinal: row.ordinal, msgid: row.msgid };

  if (row.msgid_plural) unit.msgidPlural = row.msgid_plural;
  if (row.msgctxt !== null) unit.msgctxt = row.msgctxt;
  if (row.refs) unit.refs = row.refs;
  if (row.extracted_comments) unit.extractedComments = row.extracted_comments;
  if (row.msgstr) unit.msgstr = row.msgstr;
  if (row.msgstr_plural) unit.msgstrPlural = row.msgstr_plural;

  return unit;
}
