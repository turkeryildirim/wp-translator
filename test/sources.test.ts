import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import {
  bulkTagSources,
  listSources,
  normaliseProjectUrl,
  removeSources,
  setSourceTags,
} from '../src/server/sources.ts';
import { createTag } from '../src/server/tags.ts';

describe('accepting a pasted address', () => {
  const expected = 'https://translate.wordpress.org/projects/wp-plugins/woocommerce/dev/tr/default/';

  it.each([
    'https://translate.wordpress.org/projects/wp-plugins/woocommerce/dev/tr/default/',
    'https://translate.wordpress.org/projects/wp-plugins/woocommerce/dev/tr/default',
    'translate.wordpress.org/projects/wp-plugins/woocommerce/dev/tr/default/',
    '  https://translate.wordpress.org/projects/wp-plugins/woocommerce/dev/tr/default//  ',
  ])('normalises %s', (input) => {
    expect(normaliseProjectUrl(input)).toBe(expected);
  });

  it.each([
    'https://wordpress.org/plugins/woocommerce/',
    'https://translate.wordpress.org/locale/tr/default/',
    'woocommerce',
    '',
  ])('rejects %s', (input) => {
    expect(() => normaliseProjectUrl(input)).toThrow(/translate\.wordpress\.org proje adresi/);
  });
});

describe('bulk source operations', () => {
  let db: Db;
  let ecommerce: number;
  let wordpress: number;

  beforeEach(() => {
    db = openDb(':memory:');
    wordpress = createTag(db, 'wordpress');
    ecommerce = createTag(db, 'e-ticaret');
  });

  it('adds a tag across many sources at once', () => {
    // The seed puts all 41 under one tag; splitting it one row at a time is the
    // sort of chore people skip, and the split is what makes `item` behave.
    const ids = listSources(db).slice(0, 5).map((source) => source.id);
    const changed = bulkTagSources(db, ids, { add: [ecommerce] });

    expect(changed).toBe(5);
    expect(
      listSources(db).filter((source) => source.tagIds.includes(ecommerce)),
    ).toHaveLength(5);
  });

  it('removes a tag across many sources at once', () => {
    const ids = listSources(db).map((source) => source.id);
    bulkTagSources(db, ids, { remove: [wordpress] });

    expect(listSources(db).every((source) => source.tagIds.length === 0)).toBe(true);
  });

  it('is idempotent, so a second click changes nothing', () => {
    const ids = listSources(db).slice(0, 3).map((source) => source.id);
    bulkTagSources(db, ids, { add: [ecommerce] });

    expect(bulkTagSources(db, ids, { add: [ecommerce] })).toBe(0);
  });

  it('deletes several sources and reports how many went', () => {
    const before = listSources(db).length;
    const ids = listSources(db).slice(0, 4).map((source) => source.id);

    expect(removeSources(db, ids)).toBe(4);
    expect(listSources(db)).toHaveLength(before - 4);
  });

  it('keeps glossary entries another source still vouches for', () => {
    // Removing a source must not take entries a survivor carries (R14).
    const [first, second] = listSources(db);
    const entryId = Number(
      db
        .prepare(
          `INSERT INTO glossary_entries (source_hash, source_text, tag_id, translation, origin)
           VALUES ('h', 'Save', ?, 'Kaydet', 'trusted')`,
        )
        .run(wordpress).lastInsertRowid,
    );
    const link = db.prepare(
      `INSERT INTO glossary_entry_sources (entry_id, trusted_source_id, translation, last_seen_sync_id)
       VALUES (?, ?, 'Kaydet', 1)`,
    );
    link.run(entryId, first!.id);
    link.run(entryId, second!.id);

    removeSources(db, [first!.id]);

    expect(
      (db.prepare(`SELECT count(*) AS n FROM glossary_entries`).get() as { n: number }).n,
    ).toBe(1);

    removeSources(db, [second!.id]);

    expect(
      (db.prepare(`SELECT count(*) AS n FROM glossary_entries`).get() as { n: number }).n,
    ).toBe(0);
  });

  it('replaces one source’s tags wholesale', () => {
    const id = listSources(db)[0]!.id;
    setSourceTags(db, id, [ecommerce]);

    expect(listSources(db)[0]!.tagIds).toEqual([ecommerce]);
  });
});
