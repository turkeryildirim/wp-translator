import type { Db } from '../db/open.ts';

export interface MergePreview {
  /** Rows that move without conflict. */
  moving: number;
  /** Rows the target tag already has under the same key. */
  colliding: number;
  projects: number;
  sources: number;
}

export type MergePolicy = 'keep-target' | 'take-source';

export interface MergeResult extends MergePreview {
  policy: MergePolicy;
}

/**
 * Turkish-aware normalisation. SQLite's `NOCASE` folds ASCII only, so the
 * collation is a second line of defence and this is the first.
 */
export function normaliseTagName(name: string): string {
  return name.trim().toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ');
}

export function createTag(db: Db, name: string): number {
  const normalised = normaliseTagName(name);
  if (!normalised) throw new Error('A tag needs a name.');

  const existing = db.prepare(`SELECT id FROM tags WHERE name = ?`).get(normalised) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;

  return Number(db.prepare(`INSERT INTO tags (name) VALUES (?)`).run(normalised).lastInsertRowid);
}

export function renameTag(db: Db, id: number, name: string): void {
  db.prepare(`UPDATE tags SET name = ? WHERE id = ?`).run(normaliseTagName(name), id);
}

export function deleteTag(db: Db, id: number, force = false): void {
  const entryCount = (
    db.prepare(`SELECT count(*) AS n FROM glossary_entries WHERE tag_id = ?`).get(id) as { n: number }
  ).n;
  const projectCount = countLinks(db, 'project_tags', id);
  const sourceCount = countLinks(db, 'trusted_source_tags', id);

  if (!force && (entryCount > 0 || projectCount > 0 || sourceCount > 0)) {
    const reasons: string[] = [];
    if (entryCount > 0) reasons.push(`${entryCount} sözlük girdisi`);
    if (projectCount > 0) reasons.push(`${projectCount} proje`);
    if (sourceCount > 0) reasons.push(`${sourceCount} güvenilir kaynak`);
    throw new Error(
      `Bu etiket boş değil (${reasons.join(', ')} bağlı). Girdileri korumak için 'Etiketleri Birleştir' özelliğini kullanın.`,
    );
  }

  db.transaction(() => {
    db.prepare(`DELETE FROM project_tags WHERE tag_id = ?`).run(id);
    db.prepare(`DELETE FROM trusted_source_tags WHERE tag_id = ?`).run(id);
    db.prepare(`DELETE FROM style_rules WHERE tag_id = ?`).run(id);
    db.prepare(`DELETE FROM glossary_entries WHERE tag_id = ?`).run(id);
    db.prepare(`DELETE FROM tags WHERE id = ?`).run(id);
  })();
}

/** What a merge would do, so the owner sees the collision count before choosing. */
export function previewMerge(db: Db, fromId: number, toId: number): MergePreview {
  if (fromId === toId) throw new Error('A tag cannot be merged into itself.');

  const colliding = (
    db
      .prepare(
        `SELECT count(*) AS n
           FROM glossary_entries a
           JOIN glossary_entries b
             ON b.tag_id = ?
            AND b.source_hash = a.source_hash
            AND ifnull(b.msgctxt, '') = ifnull(a.msgctxt, '')
            AND ifnull(b.pos, '') = ifnull(a.pos, '')
          WHERE a.tag_id = ?`,
      )
      .get(toId, fromId) as { n: number }
  ).n;

  const total = (
    db.prepare(`SELECT count(*) AS n FROM glossary_entries WHERE tag_id = ?`).get(fromId) as {
      n: number;
    }
  ).n;

  return {
    moving: total - colliding,
    colliding,
    projects: countLinks(db, 'project_tags', fromId),
    sources: countLinks(db, 'trusted_source_tags', fromId),
  };
}

/**
 * Merge one tag into another.
 *
 * Entries that do not collide move across; where both tags hold the same entry
 * the unique index refuses the move, and `policy` decides which side wins. One
 * policy covers the whole merge, because a merge can collide on hundreds of
 * rows and nobody answers that many prompts.
 */
export function mergeTags(
  db: Db,
  fromId: number,
  toId: number,
  policy: MergePolicy = 'keep-target',
): MergeResult {
  const preview = previewMerge(db, fromId, toId);

  return db.transaction((): MergeResult => {
    if (policy === 'take-source') {
      // Clear the target's colliding rows first, so the source's move into place.
      db.prepare(
        `DELETE FROM glossary_entries
          WHERE tag_id = ?
            AND EXISTS (
              SELECT 1 FROM glossary_entries s
               WHERE s.tag_id = ?
                 AND s.source_hash = glossary_entries.source_hash
                 AND ifnull(s.msgctxt, '') = ifnull(glossary_entries.msgctxt, '')
                 AND ifnull(s.pos, '') = ifnull(glossary_entries.pos, ''))`,
      ).run(toId, fromId);
    } else {
      db.prepare(
        `DELETE FROM glossary_entries
          WHERE tag_id = ?
            AND EXISTS (
              SELECT 1 FROM glossary_entries t
               WHERE t.tag_id = ?
                 AND t.source_hash = glossary_entries.source_hash
                 AND ifnull(t.msgctxt, '') = ifnull(glossary_entries.msgctxt, '')
                 AND ifnull(t.pos, '') = ifnull(glossary_entries.pos, ''))`,
      ).run(fromId, toId);
    }

    db.prepare(`UPDATE glossary_entries SET tag_id = ? WHERE tag_id = ?`).run(toId, fromId);
    db.prepare(`INSERT OR IGNORE INTO project_tags (project_id, tag_id)
                SELECT project_id, ? FROM project_tags WHERE tag_id = ?`).run(toId, fromId);
    db.prepare(`INSERT OR IGNORE INTO trusted_source_tags (trusted_source_id, tag_id)
                SELECT trusted_source_id, ? FROM trusted_source_tags WHERE tag_id = ?`).run(
      toId,
      fromId,
    );
    db.prepare(`DELETE FROM tags WHERE id = ?`).run(fromId);

    return { ...preview, policy };
  })();
}

export interface StyleRule {
  tagId: number | null;
  tagName: string | null;
  body: string;
  updatedAt: string | null;
}

/** The general guide plus one per tag, each a free-text field. */
export function listStyleRules(db: Db): StyleRule[] {
  return db
    .prepare(
      `SELECT s.tag_id AS tagId, t.name AS tagName, s.body, s.updated_at AS updatedAt
         FROM style_rules s LEFT JOIN tags t ON t.id = s.tag_id
        ORDER BY s.tag_id IS NOT NULL, t.name`,
    )
    .all() as StyleRule[];
}

export function saveStyleRule(db: Db, tagId: number | null, body: string): void {
  const existing = db
    .prepare(`SELECT id FROM style_rules WHERE ifnull(tag_id, -1) = ifnull(?, -1)`)
    .get(tagId) as { id: number } | undefined;

  if (existing) {
    db.prepare(`UPDATE style_rules SET body = ?, updated_at = datetime('now') WHERE id = ?`).run(
      body,
      existing.id,
    );
    return;
  }

  db.prepare(`INSERT INTO style_rules (tag_id, body) VALUES (?, ?)`).run(tagId, body);
}

/** The guide sent with a project's batches: the general text plus its tags' rules. */
export function styleGuideFor(db: Db, projectId: number): string {
  const rows = db
    .prepare(
      `SELECT t.name AS tagName, s.body
         FROM style_rules s LEFT JOIN tags t ON t.id = s.tag_id
        WHERE s.tag_id IS NULL
           OR s.tag_id IN (SELECT tag_id FROM project_tags WHERE project_id = ?)
        ORDER BY s.tag_id IS NOT NULL, t.name`,
    )
    .all(projectId) as { tagName: string | null; body: string }[];

  return rows
    .filter((row) => row.body.trim())
    .map((row) => (row.tagName ? `## ${row.tagName}\n\n${row.body.trim()}` : row.body.trim()))
    .join('\n\n');
}

function countLinks(db: Db, table: 'project_tags' | 'trusted_source_tags', tagId: number): number {
  return (
    db.prepare(`SELECT count(*) AS n FROM ${table} WHERE tag_id = ?`).get(tagId) as { n: number }
  ).n;
}
