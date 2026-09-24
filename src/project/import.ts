import type { Db } from '../db/open.ts';
import { sourceHash } from '../glossary/key.ts';
import type { Catalogue } from '../po/types.ts';
import { checkTranslation } from '../quality/check.ts';

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
 * A unit the export already translated is kept as translated and settled, with
 * `upstream = 'current'` recording that the work came from the service rather
 * than from here. Dropping it, as this used to, meant `meta/wordcamp` arrived
 * as 3 116 untranslated strings when 2 413 of them were already done — the
 * owner could neither see that nor avoid paying a model to redo it (D45).
 *
 * One request, so two statuses. GlotPress states status through an export
 * filter rather than a flag in the PO, and telling `waiting` and `fuzzy` apart
 * would cost a request each. It does not need to: measured on bbPress, all 11
 * of its fuzzy entries appear in the unfiltered export with an **empty**
 * `msgstr`, even though the `fuzzy`-filtered export gives them translations. So
 * a doubtful translation arrives here as untranslated and gets redone rather
 * than being quietly accepted — which is the outcome worth having (R32).
 */
export function importProject(db: Db, project: ProjectInput, catalogue: Catalogue): number {
  const insertProject = db.prepare(
    `INSERT INTO projects
       (family, project_path, sub_project, translate_url, slug, name, version, po_headers, imported_at)
     VALUES (@family, @projectPath, @subProject, @translateUrl, @slug, @name, @version, @headers,
             datetime('now'))`,
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

    replaceUnits(db, projectId, catalogue);
    return projectId;
  })();
}

/**
 * Write a catalogue's units under a project, in place of whatever is there.
 *
 * Shared by the first import and by a reload, so the two cannot disagree about
 * what a status means.
 */
export function replaceUnits(db: Db, projectId: number, catalogue: Catalogue): void {
  const insertUnit = db.prepare(
    `INSERT INTO translation_units
       (project_id, ordinal, source_hash, msgid, msgid_plural, msgctxt, refs, extracted_comments,
        msgstr, msgstr_plural, state, upstream, blocked)
     VALUES (@projectId, @ordinal, @hash, @msgid, @msgidPlural, @msgctxt, @refs, @extractedComments,
             @msgstr, @msgstrPlural, @state, @upstream, @blocked)`,
  );

  for (const unit of catalogue.units) {
    const translated = Boolean(unit.msgstr);
    insertUnit.run({
      projectId,
      ordinal: unit.ordinal,
      hash: sourceHash(unit.msgid, unit.msgidPlural),
      msgid: unit.msgid,
      msgidPlural: unit.msgidPlural ?? null,
      msgctxt: unit.msgctxt ?? null,
      refs: unit.refs ?? null,
      extractedComments: unit.extractedComments ?? null,
      msgstr: unit.msgstr ?? null,
      msgstrPlural: unit.msgstrPlural ?? null,
      state: translated ? 'ok' : 'untranslated',
      upstream: translated ? 'current' : 'untranslated',
      // Checked on the way in, so the queue can filter on it in SQL. An
      // upstream translation is not above suspicion — these are exactly the
      // strings a GTE is looking for.
      blocked: translated && checkTranslation(unit).length > 0 ? 1 : 0,
    });
  }
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
