import type { Db } from '../db/open.ts';
import { applyGlossary, type MatchResult } from '../glossary/match.ts';
import { parsePo } from '../po/parse.ts';
import { importProject, setProjectTags } from '../project/import.ts';
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
 * Add a project to translate.
 *
 * Only `dev` or `stable` carry the UI strings; the sub-project the owner pasted
 * is used as given (D27). Metadata comes from wordpress.org where the family has
 * it, and is simply absent otherwise rather than faked.
 */
export async function addProject(
  db: Db,
  url: string,
  tagIds: readonly number[],
): Promise<AddProjectResult> {
  const ref = parseProjectUrl(url);

  // The whole catalogue, not a status subset: a project needs every string, and
  // what is already translated upstream reaches it through the glossary.
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

export interface BulkResult {
  approved: number;
  /** Units the quality checks refused, which are never approved in bulk. */
  refused: number;
}

/**
 * Approve many units at once.
 *
 * Bulk approval is the only way the volume is survivable — Astra leaves 3 818
 * strings — and also how one mistake becomes three thousand. Units that fail a
 * quality check are excluded rather than silently included, and the caller is
 * told how many were left behind.
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
