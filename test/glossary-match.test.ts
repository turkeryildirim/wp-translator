import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { applyGlossary } from '../src/glossary/match.ts';
import { sourceHash } from '../src/glossary/key.ts';
import { importProject, setProjectTags } from '../src/project/import.ts';
import type { Catalogue, TranslationUnit } from '../src/po/types.ts';

const catalogue = (units: Partial<TranslationUnit>[]): Catalogue => ({
  headers: {},
  units: units.map((u, ordinal) => ({ ordinal, msgid: '', ...u }) as TranslationUnit),
});

let db: Db;
let ecommerce: number;
let forms: number;

const addTag = (name: string): number =>
  Number(db.prepare(`INSERT INTO tags (name) VALUES (?)`).run(name).lastInsertRowid);

const addGlossaryEntry = (
  tagId: number,
  msgid: string,
  translation: string,
  options: { msgctxt?: string; msgidPlural?: string; translationPlural?: string } = {},
): void => {
  db.prepare(
    `INSERT INTO glossary_entries
       (source_hash, source_text, source_plural, msgctxt, tag_id, translation, translation_plural, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'owner')`,
  ).run(
    sourceHash(msgid, options.msgidPlural),
    msgid,
    options.msgidPlural ?? null,
    options.msgctxt ?? null,
    tagId,
    translation,
    options.translationPlural ?? null,
  );
};

const addProject = (units: Partial<TranslationUnit>[], tagIds: number[]): number => {
  const id = importProject(
    db,
    { family: 'plugin', projectPath: 'wp-plugins/demo', translateUrl: `t${Math.random()}` },
    catalogue(units),
  );
  setProjectTags(db, id, tagIds);
  return id;
};

const unitFor = (projectId: number, msgid: string) =>
  db
    .prepare(
      `SELECT state, provenance, msgstr, msgstr_plural AS msgstrPlural
         FROM translation_units WHERE project_id = ? AND msgid = ?`,
    )
    .get(projectId, msgid) as
    | { state: string; provenance: string | null; msgstr: string | null; msgstrPlural: string | null }
    | undefined;

beforeEach(() => {
  db = openDb(':memory:');
  ecommerce = addTag('ecommerce');
  forms = addTag('forms');
});

describe('glossary matching', () => {
  it('fills an exact match and marks it complete', () => {
    addGlossaryEntry(ecommerce, 'Add to cart', 'Sepete ekle');
    const project = addProject([{ msgid: 'Add to cart' }], [ecommerce]);

    expect(applyGlossary(db, project)).toEqual({ filled: 1, ambiguous: 0, unmatched: 0 });
    expect(unitFor(project, 'Add to cart')).toMatchObject({
      state: 'ok',
      provenance: 'glossary',
      msgstr: 'Sepete ekle',
    });
  });

  it('does not match on case, because matching is byte-exact', () => {
    // Lowercasing would gain 253 matches across WooCommerce of which 197 map to a
    // different translation, and nothing malformed exists to catch it (R13).
    addGlossaryEntry(ecommerce, 'Saved for Later', 'Sonraya Kaydet');
    const project = addProject([{ msgid: 'Saved for later' }], [ecommerce]);

    expect(applyGlossary(db, project)).toMatchObject({ filled: 0, unmatched: 1 });
    expect(unitFor(project, 'Saved for later')?.state).toBe('untranslated');
  });

  it('does not match on trimmed whitespace', () => {
    addGlossaryEntry(ecommerce, 'SKU: ', 'Stok kodu: ');
    const project = addProject([{ msgid: 'SKU:' }], [ecommerce]);

    expect(applyGlossary(db, project)).toMatchObject({ filled: 0, unmatched: 1 });
  });

  it('prefers an entry under the unit’s own context', () => {
    addGlossaryEntry(ecommerce, 'May', 'Mayıs');
    addGlossaryEntry(ecommerce, 'May', 'May', { msgctxt: 'May abbreviation' });
    const project = addProject([{ msgid: 'May', msgctxt: 'May abbreviation' }], [ecommerce]);

    applyGlossary(db, project);
    expect(unitFor(project, 'May')?.msgstr).toBe('May');
  });

  it('falls back to the context-less entry when the context is unknown', () => {
    addGlossaryEntry(ecommerce, 'May', 'Mayıs');
    const project = addProject([{ msgid: 'May', msgctxt: 'genitive' }], [ecommerce]);

    applyGlossary(db, project);
    expect(unitFor(project, 'May')?.msgstr).toBe('Mayıs');
  });

  it('never gives a context-free unit a context-bearing translation', () => {
    // The reverse fallback would reintroduce exactly the collapse the key prevents.
    addGlossaryEntry(ecommerce, 'May', 'May', { msgctxt: 'May abbreviation' });
    const project = addProject([{ msgid: 'May' }], [ecommerce]);

    expect(applyGlossary(db, project)).toMatchObject({ filled: 0, unmatched: 1 });
  });

  it('sends a string its tags disagree on to review, unfilled', () => {
    addGlossaryEntry(ecommerce, 'Item', 'Ürün');
    addGlossaryEntry(forms, 'Item', 'Öge');
    const project = addProject([{ msgid: 'Item' }], [ecommerce, forms]);

    expect(applyGlossary(db, project)).toEqual({ filled: 0, ambiguous: 1, unmatched: 0 });
    expect(unitFor(project, 'Item')).toMatchObject({
      state: 'review',
      provenance: 'glossary',
      msgstr: null,
    });
  });

  it('fills when several tags agree', () => {
    addGlossaryEntry(ecommerce, 'Save', 'Kaydet');
    addGlossaryEntry(forms, 'Save', 'Kaydet');
    const project = addProject([{ msgid: 'Save' }], [ecommerce, forms]);

    expect(applyGlossary(db, project)).toMatchObject({ filled: 1, ambiguous: 0 });
  });

  it('carries the plural translation', () => {
    addGlossaryEntry(ecommerce, '%s item', '%s öge', {
      msgidPlural: '%s items',
      translationPlural: '%s öge',
    });
    const project = addProject([{ msgid: '%s item', msgidPlural: '%s items' }], [ecommerce]);

    applyGlossary(db, project);
    expect(unitFor(project, '%s item')).toMatchObject({
      msgstr: '%s öge',
      msgstrPlural: '%s öge',
    });
  });

  it('matches nothing when the project has no tags', () => {
    addGlossaryEntry(ecommerce, 'Save', 'Kaydet');
    const project = addProject([{ msgid: 'Save' }], []);

    expect(applyGlossary(db, project)).toEqual({ filled: 0, ambiguous: 0, unmatched: 1 });
  });

  it('leaves already-settled units alone on a second run', () => {
    addGlossaryEntry(ecommerce, 'Save', 'Kaydet');
    const project = addProject([{ msgid: 'Save' }], [ecommerce]);

    applyGlossary(db, project);
    expect(applyGlossary(db, project)).toEqual({ filled: 0, ambiguous: 0, unmatched: 0 });
  });
});
