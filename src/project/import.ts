import type { Db } from '../db/open.ts';
import { sourceHash } from '../glossary/key.ts';
import type { Catalogue } from '../po/types.ts';

export type Family = 'plugin' | 'theme' | 'core' | 'apps' | 'meta' | 'patterns';

export interface ProjectInput {
  family: Family;
  /** e.g. `wp-plugins/woocommerce`. */
  projectPath: string;
  translateUrl: string;
  /** `dev` or `stable`; absent for families with no sub-project, such as themes. */
  subProject?: string;
  /** Plugins and themes only; the other families are not slug-addressable. */
  slug?: string;
  name?: string;
  version?: string;
}

/**
 * Store a project and its catalogue.
 *
 * Units land `untranslated` even when the export already carried a translation:
 * a project is imported to be translated, and anything already done upstream
 * reaches it through the glossary instead, where it is attributable to a source.
 */
export function importProject(db: Db, project: ProjectInput, catalogue: Catalogue): number {
  const insertProject = db.prepare(
    `INSERT INTO projects
       (family, project_path, sub_project, translate_url, slug, name, version, po_headers, imported_at)
     VALUES (@family, @projectPath, @subProject, @translateUrl, @slug, @name, @version, @headers,
             datetime('now'))`,
  );
  const insertUnit = db.prepare(
    `INSERT INTO translation_units
       (project_id, ordinal, source_hash, msgid, msgid_plural, msgctxt, refs, extracted_comments)
     VALUES (@projectId, @ordinal, @hash, @msgid, @msgidPlural, @msgctxt, @refs, @extractedComments)`,
  );

  return db.transaction((): number => {
    const projectId = Number(
      insertProject.run({
        family: project.family,
        projectPath: project.projectPath,
        subProject: project.subProject ?? null,
        translateUrl: project.translateUrl,
        slug: project.slug ?? null,
        name: project.name ?? null,
        version: project.version ?? null,
        headers: JSON.stringify(catalogue.headers),
      }).lastInsertRowid,
    );

    for (const unit of catalogue.units) {
      insertUnit.run({
        projectId,
        ordinal: unit.ordinal,
        hash: sourceHash(unit.msgid, unit.msgidPlural),
        msgid: unit.msgid,
        msgidPlural: unit.msgidPlural ?? null,
        msgctxt: unit.msgctxt ?? null,
        refs: unit.refs ?? null,
        extractedComments: unit.extractedComments ?? null,
      });
    }

    return projectId;
  })();
}

/** Attach domain tags to a project. Order is not significant — see `applyGlossary`. */
export function setProjectTags(db: Db, projectId: number, tagIds: readonly number[]): void {
  const clear = db.prepare(`DELETE FROM project_tags WHERE project_id = ?`);
  const add = db.prepare(`INSERT INTO project_tags (project_id, tag_id) VALUES (?, ?)`);

  db.transaction(() => {
    clear.run(projectId);
    for (const tagId of tagIds) add.run(projectId, tagId);
  })();
}
