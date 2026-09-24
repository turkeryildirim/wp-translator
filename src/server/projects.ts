import type { Db } from '../db/open.ts';
import { applyGlossary, type MatchResult } from '../glossary/match.ts';
import { parsePo } from '../po/parse.ts';
import { importProject, replaceUnits, setProjectTags } from '../project/import.ts';
import { fetchExport } from '../wporg/fetch.ts';
import { fetchMetadata } from '../wporg/metadata.ts';
import { exportUrl, parseProjectUrl } from '../wporg/project.ts';
import { saveUnit } from './review.ts';

export interface AddProjectResult {
  projectId: number;
  strings: number;
  match: MatchResult;
  /** Tags wordpress.org lists for the project, as suggestions for the owner. */
  suggestedTags: string[];
}

/**
 * Add a project to translate, using the sub-project the owner pasted. Metadata
 * comes from wordpress.org where the family has it, and is absent otherwise.
 */
export async function addProject(
  db: Db,
  url: string,
  tagIds: readonly number[],
): Promise<AddProjectResult> {
  const ref = parseProjectUrl(url);

  // The whole catalogue in one request. GlotPress puts status in an export
  // filter rather than in the PO, and a fuzzy entry reaches us untranslated.
  const [po, metadata] = await Promise.all([
    fetchExport(exportUrl(ref.projectPath, { status: 'all' })),
    fetchMetadata(ref.family, ref.slug),
  ]);

  const catalogue = parsePo(po);
  if (catalogue.units.length === 0) {
    throw new Error(`${ref.projectPath} returned an empty catalogue. Check the URL.`);
  }

  const projectId = importProject(
    db,
    {
      family: ref.family,
      projectPath: ref.projectPath,
      translateUrl: url,
      ...(ref.subProject ? { subProject: ref.subProject } : {}),
      ...(ref.slug ? { slug: ref.slug } : {}),
      ...(metadata.name ? { name: metadata.name } : {}),
      ...(metadata.version ? { version: metadata.version } : {}),
    },
    catalogue,
  );

  setProjectTags(db, projectId, tagIds);

  if (metadata.description || metadata.readme) {
    db.prepare(`UPDATE projects SET description = ?, readme = ? WHERE id = ?`).run(
      metadata.description ?? null,
      metadata.readme ?? null,
      projectId,
    );
  }

  return {
    projectId,
    strings: catalogue.units.length,
    match: applyGlossary(db, projectId),
    suggestedTags: metadata.tags ?? [],
  };
}

export function removeProject(db: Db, projectId: number): void {
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId);
}

export interface ReloadResult {
  strings: number;
  /** Units carrying work that was not the service's, which this discarded. */
  discarded: number;
  match: MatchResult;
}

/**
 * Fetch the project again and replace its catalogue.
 *
 * **Discards** the units and everything on them — the model's output, the
 * owner's edits and approvals, the check exceptions. No merge is attempted,
 * because a source string can change under a `msgctxt` that did not. The
 * project row survives, so its tags and its id stay put.
 */
export async function reloadProject(db: Db, projectId: number): Promise<ReloadResult> {
  const project = db
    .prepare(`SELECT project_path AS projectPath FROM projects WHERE id = ?`)
    .get(projectId) as { projectPath: string } | undefined;
  if (!project) throw new Error(`No project with id ${projectId}.`);

  const catalogue = parsePo(await fetchExport(exportUrl(project.projectPath, { status: 'all' })));
  if (catalogue.units.length === 0) {
    // An empty catalogue is what a moved or renamed project looks like.
    throw new Error(`${project.projectPath} returned an empty catalogue; nothing was changed.`);
  }

  const discarded = ownWork(db, projectId);

  db.transaction(() => {
    db.prepare(`DELETE FROM translation_units WHERE project_id = ?`).run(projectId);
    replaceUnits(db, projectId, catalogue);
    db.prepare(`UPDATE projects SET po_headers = ?, imported_at = datetime('now') WHERE id = ?`).run(
      JSON.stringify(catalogue.headers),
      projectId,
    );
  })();

  return { strings: catalogue.units.length, discarded, match: applyGlossary(db, projectId) };
}

/** Units the owner or the model touched, as opposed to what arrived translated. */
export function ownWork(db: Db, projectId: number): number {
  return (
    db
      .prepare(
        `SELECT count(*) AS n FROM translation_units
          WHERE project_id = ? AND (provenance IS NOT NULL OR state = 'review')`,
      )
      .get(projectId) as { n: number }
  ).n;
}

export interface BulkResult {
  approved: number;
  /** Units the quality checks refused, which are never approved in bulk. */
  refused: number;
}

/**
 * Approve many units at once. Units that fail a quality check are excluded
 * rather than silently included, and the caller is told how many.
 */
export function bulkApprove(db: Db, unitIds: readonly number[]): BulkResult {
  const result: BulkResult = { approved: 0, refused: 0 };
  if (unitIds.length === 0) return result;

  return db.transaction((): BulkResult => {
    for (const id of unitIds) {
      if (saveUnit(db, id).blocked) result.refused += 1;
      else result.approved += 1;
    }
    return result;
  })();
}
