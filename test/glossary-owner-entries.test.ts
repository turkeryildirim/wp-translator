import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { createEntry, deleteEntry, searchGlossary } from '../src/server/glossary.ts';
import { sourceHash } from '../src/glossary/key.ts';

let db: Db;
let tagId: number;

beforeEach(() => {
  db = openDb(':memory:');
  tagId = (db.prepare(`SELECT id FROM tags WHERE name = 'wordpress'`).get() as { id: number }).id;
});

/** An entry a trusted source vouches for, which is the case that comes back. */
const vouched = (source: string, translation: string): number => {
  const entryId = Number(
    db
      .prepare(
        `INSERT INTO glossary_entries (source_hash, source_text, msgctxt, tag_id, translation, origin)
         VALUES (?, ?, NULL, ?, ?, 'trusted')`,
      )
      .run(sourceHash(source, undefined), source, tagId, translation).lastInsertRowid,
  );
  const sourceId = Number(
    db
      .prepare(
        `INSERT INTO trusted_sources (translate_url, family, project_path)
         VALUES ('https://translate.wordpress.org/projects/wp-plugins/x/', 'plugin', 'wp-plugins/x')`,
      )
      .run().lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO glossary_entry_sources (entry_id, trusted_source_id, translation, last_seen_sync_id)
     VALUES (?, ?, ?, 1)`,
  ).run(entryId, sourceId, translation);
  return entryId;
};

describe('entries the owner writes', () => {
  it('stores the words without their surrounding whitespace', () => {
    // Matching re-applies each string's own shape, so an entry written with a
    // trailing space would never match the string without one.
    const entry = createEntry(db, {
      sourceText: '  Save  ',
      translation: '\tKaydet\n',
      tagId,
    });

    expect(entry.sourceText).toBe('Save');
    expect(entry.translation).toBe('Kaydet');
  });

  it('is the owner’s, so the sweep leaves it alone', () => {
    expect(createEntry(db, { sourceText: 'Save', translation: 'Kaydet', tagId }).origin).toBe(
      'owner',
    );
  });

  it('is found by the same search the panel uses', () => {
    createEntry(db, { sourceText: 'Save', translation: 'Kaydet', tagId });

    expect(searchGlossary(db, { search: 'Save' }).total).toBe(1);
  });

  it('adds a second wording rather than colliding with the first', () => {
    // The key is source plus translation: two wordings of one string are two
    // rows, and matching ranks them.
    createEntry(db, { sourceText: 'Item', translation: 'Öge', tagId });
    createEntry(db, { sourceText: 'Item', translation: 'Ürün', tagId });

    expect(searchGlossary(db, { search: 'Item' }).total).toBe(2);
  });

  it('refuses the same wording twice, by name', () => {
    createEntry(db, { sourceText: 'Save', translation: 'Kaydet', tagId });

    expect(() => createEntry(db, { sourceText: 'Save', translation: 'Kaydet', tagId })).toThrow(
      /zaten var/,
    );
  });

  it('refuses a plural translation with no plural source to attach it to', () => {
    expect(() =>
      createEntry(db, { sourceText: 'Item', translation: 'Öge', translationPlural: 'Ögeler', tagId }),
    ).toThrow(/çoğul/i);
  });

  it('refuses a plural source with no plural translation', () => {
    // Such an entry fills a unit's singular and leaves its plural empty, which
    // the checks refuse on every string it matches.
    expect(() =>
      createEntry(db, { sourceText: '%s item', sourcePlural: '%s items', translation: '%s öge', tagId }),
    ).toThrow(/çoğul/i);
  });

  it('takes both halves of a plural entry', () => {
    const entry = createEntry(db, {
      sourceText: '%s item',
      sourcePlural: '%s items',
      translation: '%s öge',
      translationPlural: '%s öge',
      tagId,
    });

    expect(entry.sourcePlural).toBe('%s items');
    expect(entry.translationPlural).toBe('%s öge');
  });
});

describe('removing an entry', () => {
  it('takes the owner’s own away for good', () => {
    const entry = createEntry(db, { sourceText: 'Save', translation: 'Kaydet', tagId });

    expect(deleteEntry(db, entry.id).returnsOnSync).toBe(false);
    expect(searchGlossary(db, { search: 'Save' }).total).toBe(0);
  });

  it('says so when a trusted source will write it back', () => {
    // Otherwise the entry reappears at the next update and the owner learns it
    // by finding it there again.
    const entryId = vouched('Save', 'Kaydet');

    expect(deleteEntry(db, entryId).returnsOnSync).toBe(true);
  });

  it('takes the source links with it rather than orphaning them', () => {
    const entryId = vouched('Save', 'Kaydet');
    deleteEntry(db, entryId);

    const left = db
      .prepare(`SELECT count(*) AS n FROM glossary_entry_sources WHERE entry_id = ?`)
      .get(entryId) as { n: number };
    expect(left.n).toBe(0);
  });

  it('fails on an id that is not there', () => {
    expect(() => deleteEntry(db, 9999)).toThrow(/9999/);
  });
});
