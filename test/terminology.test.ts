import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { sourceHash } from '../src/glossary/key.ts';
import { collectTerms } from '../src/glossary/terminology.ts';
import { importProject, setProjectTags } from '../src/project/import.ts';

let db: Db;
let ecommerce: number;
let other: number;
let projectId: number;

const addTag = (name: string): number =>
  Number(db.prepare(`INSERT INTO tags (name) VALUES (?)`).run(name).lastInsertRowid);

const addTerm = (tagId: number, source: string, translation: string, pos?: string): void => {
  db.prepare(
    `INSERT INTO glossary_entries (source_hash, source_text, msgctxt, pos, tag_id, translation, origin)
     VALUES (?, ?, NULL, ?, ?, ?, 'owner')`,
  ).run(sourceHash(source), source, pos ?? null, tagId, translation);
};

beforeEach(() => {
  db = openDb(':memory:');
  ecommerce = addTag('ecommerce');
  other = addTag('other');
  projectId = importProject(
    db,
    { family: 'plugin', projectPath: 'wp-plugins/demo', translateUrl: 't' },
    { headers: {}, units: [] },
  );
  setProjectTags(db, projectId, [ecommerce]);
});

describe('terminology retrieval', () => {
  it('finds a single-word term inside a sentence', () => {
    addTerm(ecommerce, 'Item', 'Ürün');

    expect(collectTerms(db, projectId, ['Remove this item from the cart'])).toEqual([
      { source: 'Item', readings: [{ translation: 'Ürün' }] },
    ]);
  });

  it('matches regardless of case in the source string', () => {
    addTerm(ecommerce, 'Overlay position', 'Yer paylaşımı konumu');

    expect(collectTerms(db, projectId, ['Change the OVERLAY POSITION now'])).toHaveLength(1);
  });

  it('finds multi-word terms', () => {
    addTerm(ecommerce, 'Add to cart', 'Sepete ekle');

    expect(collectTerms(db, projectId, ['The Add to cart button is hidden'])).toEqual([
      { source: 'Add to cart', readings: [{ translation: 'Sepete ekle' }] },
    ]);
  });

  it('reports every translation a term has, which is the case that matters', () => {
    // A term the glossary translates more than one way is exactly what the model
    // cannot guess; 60–76% of strings carrying a known term carry one of these.
    addTerm(ecommerce, 'Item', 'Ürün');
    addTerm(other, 'Item', 'Öge');
    setProjectTags(db, projectId, [ecommerce, other]);

    expect(collectTerms(db, projectId, ['Delete item'])).toEqual([
      { source: 'Item', readings: [{ translation: 'Öge' }, { translation: 'Ürün' }] },
    ]);
  });

  it('ignores terms under tags the project does not carry', () => {
    addTerm(other, 'Item', 'Öge');

    expect(collectTerms(db, projectId, ['Delete item'])).toEqual([]);
  });

  it('ignores glossary entries too long to be terms', () => {
    const sentence = 'This is a long sentence that is a string, not a term at all';
    addTerm(ecommerce, sentence, 'Uzun cümle');

    expect(collectTerms(db, projectId, [sentence])).toEqual([]);
  });

  it('does not match a term spanning a word boundary it does not have', () => {
    addTerm(ecommerce, 'cart', 'sepet');

    expect(collectTerms(db, projectId, ['Descartes wrote this'])).toEqual([]);
  });

  it('deduplicates across the batch', () => {
    addTerm(ecommerce, 'Item', 'Ürün');

    expect(collectTerms(db, projectId, ['One item', 'Another item', 'Third item'])).toHaveLength(1);
  });

  it('keeps noun and verb readings of the same term apart', () => {
    // The official glossary distinguishes these, and it is the item→ürün/öge
    // problem at term level: `archive` is arşiv as a noun, arşivle as a verb.
    addTerm(ecommerce, 'archive', 'arşiv', 'noun');
    addTerm(ecommerce, 'archive', 'arşivle', 'verb');

    expect(collectTerms(db, projectId, ['Move to archive'])).toEqual([
      {
        source: 'archive',
        readings: [
          { translation: 'arşiv', pos: 'noun' },
          { translation: 'arşivle', pos: 'verb' },
        ],
      },
    ]);
  });

  it('returns nothing for an empty batch', () => {
    addTerm(ecommerce, 'Item', 'Ürün');

    expect(collectTerms(db, projectId, [])).toEqual([]);
  });
});
