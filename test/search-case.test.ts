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

const found = (
  search: string,
  caseSensitive?: boolean,
  scope?: 'source' | 'translation',
): string[] =>
  searchGlossary(db, {
    search,
    ...(caseSensitive ? { caseSensitive } : {}),
    ...(scope ? { scope } : {}),
  }).rows.map((row) => row.sourceText);

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

describe('narrowing a search to one column', () => {
  beforeEach(() => {
    // `Save` is also a Turkish word fragment and appears in translations that
    // are not about saving; the source column alone is how you get past that.
    add('Save', 'Kaydet');
    add('Saved', 'Kaydedildi');
    add('Keep', 'Save et');
  });

  it('searches both columns by default', () => {
    expect(found('save').sort()).toEqual(['Keep', 'Save', 'Saved']);
  });

  it('looks only in the source when asked', () => {
    expect(found('save', false, 'source').sort()).toEqual(['Save', 'Saved']);
  });

  it('looks only in the translation when asked', () => {
    expect(found('save', false, 'translation')).toEqual(['Keep']);
  });

  it('narrows and folds at the same time', () => {
    add('Content', 'İÇERİK');
    expect(found('içerik', false, 'translation')).toEqual(['Content']);
    expect(found('içerik', false, 'source')).toEqual([]);
  });

  it('narrows and matches case at the same time', () => {
    expect(found('save', true, 'source')).toEqual([]);
    expect(found('Save', true, 'source').sort()).toEqual(['Save', 'Saved']);
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
