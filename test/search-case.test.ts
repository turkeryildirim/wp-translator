import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { fold } from '../src/db/fold.ts';
import { searchGlossary } from '../src/server/glossary.ts';
import { sourceHash } from '../src/glossary/key.ts';

let db: Db;
let tagId: number;

const add = (source: string, translation: string): void => {
  db.prepare(
    `INSERT INTO glossary_entries
       (source_hash, source_text, msgctxt, tag_id, translation, origin)
     VALUES (?, ?, NULL, ?, ?, 'owner')`,
  ).run(sourceHash(source, undefined), source, tagId, translation);
};

const found = (search: string, caseSensitive?: boolean): string[] =>
  searchGlossary(db, { search, ...(caseSensitive ? { caseSensitive } : {}) }).rows.map(
    (row) => row.sourceText,
  );

beforeEach(() => {
  db = openDb(':memory:');
  tagId = Number(db.prepare(`INSERT INTO tags (name) VALUES ('general')`).run().lastInsertRowid);
});

describe('folding a search', () => {
  it('finds a Turkish word however it is capitalised', () => {
    // SQLite's own folding is ASCII only, so `İÇERİK` matched nothing while
    // `SAVE` matched `save` — the half that failed is the Turkish half (R31).
    add('Content', 'İÇERİK');
    add('Body', 'içerik');

    expect(found('içerik')).toHaveLength(2);
    expect(found('İÇERİK')).toHaveLength(2);
    expect(found('İçerik')).toHaveLength(2);
  });

  it('treats the four i-forms as one', () => {
    // Turkish casing sends `I` to `ı`, which is right for Turkish and wrong for
    // `ITEM` — and the source column is English. Both columns share one box.
    add('ITEM', 'ürün');
    add('Item', 'öge');

    expect(found('item')).toHaveLength(2);
    expect(found('ıtem')).toHaveLength(2);
  });

  it('still folds plain ASCII, which is what it did before', () => {
    add('Save', 'Kaydet');
    expect(found('SAVE')).toEqual(['Save']);
  });

  it('compares bytes when the owner asks for it', () => {
    add('Save', 'Kaydet');
    add('save', 'kaydet');

    expect(found('Save', true)).toEqual(['Save']);
    expect(found('save', true)).toEqual(['save']);
    expect(found('SAVE', true)).toEqual([]);
  });

  it('keeps ı and i apart under a sensitive search', () => {
    add('ITEM', 'ürün');
    expect(found('ITEM', true)).toEqual(['ITEM']);
    expect(found('item', true)).toEqual([]);
  });

  it('searches the translation as well as the source', () => {
    add('Update', 'GÜNCELLE');
    expect(found('güncelle')).toEqual(['Update']);
  });
});

describe('the fold itself', () => {
  it('avoids the combining dot that a plain lowercase leaves behind', () => {
    // 'İ'.toLowerCase() is 'i' plus U+0307, which matches nothing.
    expect(fold('İ')).toBe('i');
    expect(fold('İ')).not.toContain('̇');
  });

  it('leaves the other Turkish letters to ordinary lowercasing', () => {
    expect(fold('ŞĞÜÖÇ')).toBe('şğüöç');
  });
});
