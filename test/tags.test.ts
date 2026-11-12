import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { createTag, deleteTag, renameTag } from '../src/server/tags.ts';

describe('tag management', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('creates and renames a tag', () => {
    const id = createTag(db, 'WooCommerce');
    expect(id).toBeGreaterThan(0);

    renameTag(db, id, 'woo');
    const row = db.prepare('SELECT name FROM tags WHERE id = ?').get(id) as { name: string };
    expect(row.name).toBe('woo');
  });

  it('deletes an empty tag without issue', () => {
    const id = createTag(db, 'empty-tag');
    expect(db.prepare('SELECT count(*) AS n FROM tags WHERE id = ?').get(id)).toEqual({ n: 1 });

    deleteTag(db, id);
    expect(db.prepare('SELECT count(*) AS n FROM tags WHERE id = ?').get(id)).toEqual({ n: 0 });
  });

  it('refuses to delete a non-empty tag unless force=true', () => {
    const id = createTag(db, 'used-tag');
    db.prepare(`
      INSERT INTO glossary_entries (source_hash, source_text, tag_id, translation, origin)
      VALUES ('hash123', 'Hello', ?, 'Merhaba', 'owner')
    `).run(id);

    expect(() => deleteTag(db, id, false)).toThrow(/Bu etiket boş değil/);

    // With force = true, it deletes cleanly along with its entries
    deleteTag(db, id, true);
    expect(db.prepare('SELECT count(*) AS n FROM tags WHERE id = ?').get(id)).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM glossary_entries WHERE tag_id = ?').get(id)).toEqual({ n: 0 });
  });
});
