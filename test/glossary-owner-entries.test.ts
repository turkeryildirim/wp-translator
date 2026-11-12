import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import {
  copyMemoryToTerms,
  createEntry,
  deleteEntries,
  deleteEntry,
  searchGlossary,
  updateEntry,
} from '../src/server/glossary.ts';
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
  it('takes the owner’s own away', () => {
    const entry = createEntry(db, { sourceText: 'Save', translation: 'Kaydet', tagId });

    deleteEntry(db, entry.id);
    expect(searchGlossary(db, { search: 'Save' }).total).toBe(0);
  });

  it('refuses one a trusted source carries, and leaves it there', () => {
    // A removal the next update undoes is not a removal. The source is what has
    // to go instead, so this says no rather than appearing to work.
    const entryId = vouched('Save', 'Kaydet');

    expect(() => deleteEntry(db, entryId)).toThrow(/kaynak/i);
    expect(searchGlossary(db, { search: 'Save' }).total).toBe(1);
  });

  it('refuses one a source still carries after the owner reworded it', () => {
    // `updateEntry` makes an edited row the owner's, so origin alone does not
    // say whether anything upstream will write it back.
    const entryId = vouched('Save', 'Kaydet');
    updateEntry(db, entryId, 'Sakla');

    expect(() => deleteEntry(db, entryId)).toThrow(/kaynak/i);
  });

  it('allows removing a term from the official glossary', () => {
    const termId = Number(
      db
        .prepare(
          `INSERT INTO glossary_entries
             (source_hash, source_text, msgctxt, pos, tag_id, translation, origin, is_official)
           VALUES (?, 'archive', NULL, 'noun', ?, 'arşiv', 'owner', 1)`,
        )
        .run(sourceHash('archive', undefined), tagId).lastInsertRowid,
    );

    expect(deleteEntry(db, termId)).toEqual({ removed: termId });
    expect(searchGlossary(db, { search: 'archive' }).total).toBe(0);
  });

  it('allows removing an owner-created term with a part of speech', () => {
    const entry = createEntry(db, {
      sourceText: 'custom term',
      translation: 'özel terim',
      pos: 'noun',
      tagId,
    });

    expect(entry.isOfficial).toBe(0);
    deleteEntry(db, entry.id);
    expect(searchGlossary(db, { search: 'custom term' }).total).toBe(0);
  });

  it('allows bulk deleting terms', () => {
    const e1 = createEntry(db, { sourceText: 'term1', translation: 'terim1', pos: 'noun', tagId });
    const e2 = createEntry(db, { sourceText: 'term2', translation: 'terim2', pos: 'verb', tagId });

    expect(deleteEntries(db, [e1.id, e2.id])).toEqual({ removed: 2 });
    expect(searchGlossary(db, { search: 'term' }).total).toBe(0);
  });

  it('copies translation memory to glossary terms without overriding existing terms', () => {
    const mem1 = createEntry(db, { sourceText: 'Cart', translation: 'Sepet', tagId });
    const mem2 = createEntry(db, { sourceText: 'Checkout', translation: 'Ödeme', tagId });

    // Pre-create 'Cart' with 'Alışveriş Sepeti' as an existing term
    createEntry(db, { sourceText: 'Cart', translation: 'Alışveriş Sepeti', pos: 'noun', tagId });

    // Copy mem1 and mem2 to terms
    const result = copyMemoryToTerms(db, [mem1.id, mem2.id], 'noun');
    expect(result.added).toBe(2);

    // Let's test with exact same wording:
    const mem3 = createEntry(db, { sourceText: 'Checkout', translation: 'Kasa', tagId });
    createEntry(db, { sourceText: 'Checkout', translation: 'Kasa', pos: 'noun', tagId });
    const res2 = copyMemoryToTerms(db, [mem3.id], 'noun');
    expect(res2.added).toBe(0);
    expect(res2.skipped).toBe(1);
  });

  it('automatically infers parts of speech when copying memory', () => {
    const memAction = createEntry(db, { sourceText: 'Save changes', translation: 'Değişiklikleri kaydet', tagId });
    const memAbbr = createEntry(db, { sourceText: 'URL', translation: 'URL', tagId });
    const memExpr = createEntry(db, { sourceText: 'Are you sure you want to proceed?', translation: 'Devam etmek istiyor musunuz?', tagId });
    const memNoun = createEntry(db, { sourceText: 'Product category', translation: 'Ürün kategorisi', tagId });

    const res = copyMemoryToTerms(db, [memAction.id, memAbbr.id, memExpr.id, memNoun.id]);
    expect(res.added).toBe(4);
    expect(res.entries.find((e) => e.id === memAction.id)?.pos).toBe('verb');
    expect(res.entries.find((e) => e.id === memAbbr.id)?.pos).toBe('abbreviation');
    expect(res.entries.find((e) => e.id === memExpr.id)?.pos).toBe('expression');
    expect(res.entries.find((e) => e.id === memNoun.id)?.pos).toBe('noun');
  });

  it('fails on an id that is not there', () => {
    expect(() => deleteEntry(db, 9999)).toThrow(/9999/);
  });
});
