import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { applyGlossary } from '../src/glossary/match.ts';
import { sourceHash } from '../src/glossary/key.ts';
import { importProject, setProjectTags } from '../src/project/import.ts';
import { defaultTagId } from '../src/server/sources.ts';
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
  ecommerce = addTag('e-commerce');
  forms = addTag('forms');
});

describe('glossary matching', () => {
  it('fills an exact match and marks it complete', () => {
    addGlossaryEntry(ecommerce, 'Add to cart', 'Sepete ekle');
    const projectId = addProject([{ msgid: 'Add to cart' }], [ecommerce]);

    expect(applyGlossary(db, projectId)).toEqual({ filled: 1, alternatives: 0, unmatched: 0 });
    expect(unitFor(projectId, 'Add to cart')).toMatchObject({
      state: 'ok',
      provenance: 'glossary',
      msgstr: 'Sepete ekle',
    });
  });

  it('does not match on case, because matching is byte-exact', () => {
    // Lowercasing would gain matches that map to a different translation:
    // `Saved for Later` is `Sonraya Kaydet`, `Saved for later` is `Sonraya
    // kaydedildi`.
    addGlossaryEntry(ecommerce, 'Add to cart', 'Sepete ekle');
    const projectId = addProject([{ msgid: 'Add To Cart' }], [ecommerce]);

    expect(applyGlossary(db, projectId).unmatched).toBe(1);
  });

  it('matches a padded source and gives the padding back', () => {
    // Surrounding whitespace is shape, not meaning: the glossary stores the
    // words and the unit's own shape goes back on what it is filled with.
    addGlossaryEntry(ecommerce, 'Save', 'Kaydet');
    const projectId = addProject([{ msgid: '  Save \n' }], [ecommerce]);

    expect(applyGlossary(db, projectId).filled).toBe(1);
    expect(unitFor(projectId, '  Save \n')?.msgstr).toBe('  Kaydet \n');
  });

  it('still keeps strings apart on anything but whitespace', () => {
    // Punctuation is not shape. `Save.` is a different string.
    addGlossaryEntry(ecommerce, 'Save', 'Kaydet');
    const projectId = addProject([{ msgid: 'Save.' }], [ecommerce]);

    expect(applyGlossary(db, projectId).unmatched).toBe(1);
  });

  it('ignores the unit’s context entirely', () => {
    // A glossary's contexts are the source project's own keys, which do not
    // recur in someone else's plugin.
    addGlossaryEntry(ecommerce, 'About', 'Hakkında');
    const projectId = addProject([{ msgid: 'About', msgctxt: 'a context nobody has seen' }], [ecommerce]);

    expect(applyGlossary(db, projectId).filled).toBe(1);
    expect(unitFor(projectId, 'About')?.msgstr).toBe('Hakkında');
  });

  it('fills the best-supported reading and counts the rest as alternatives', () => {
    vouched(ecommerce, 'Mail', 'Posta', ['core']);
    vouched(ecommerce, 'Mail', 'E-posta', ['woocommerce', 'gutenberg']);
    const projectId = addProject([{ msgid: 'Mail' }], [ecommerce]);

    expect(applyGlossary(db, projectId)).toEqual({ filled: 1, alternatives: 1, unmatched: 0 });
    expect(unitFor(projectId, 'Mail')?.msgstr).toBe('E-posta');
  });

  it('falls to the highest-ranked source when support is level', () => {
    // Most disagreements are two-way ties, so the owner's ranking decides.
    rank('core', 1);
    rank('woocommerce', 2);
    // The lower-ranked wording is stored first, so passing cannot be an
    // accident of insertion order.
    vouched(ecommerce, 'Save', 'Sakla', ['woocommerce']);
    vouched(ecommerce, 'Save', 'Kaydet', ['core']);
    const projectId = addProject([{ msgid: 'Save' }], [ecommerce]);

    applyGlossary(db, projectId);
    expect(unitFor(projectId, 'Save')?.msgstr).toBe('Kaydet');
  });

  it('puts the owner’s own entry above every source', () => {
    // A source outvoting the owner would undo their edit on the next update.
    vouched(ecommerce, 'Item', 'Öğe', ['core', 'woocommerce', 'gutenberg']);
    addGlossaryEntry(ecommerce, 'Item', 'Ürün');
    const projectId = addProject([{ msgid: 'Item' }], [ecommerce]);

    applyGlossary(db, projectId);
    expect(unitFor(projectId, 'Item')?.msgstr).toBe('Ürün');
  });

  it('offers readings from every tag the project carries', () => {
    addGlossaryEntry(ecommerce, 'Item', 'Ürün');
    addGlossaryEntry(forms, 'Item', 'Öge');
    const projectId = addProject([{ msgid: 'Item' }], [ecommerce, forms]);

    expect(applyGlossary(db, projectId)).toEqual({ filled: 1, alternatives: 1, unmatched: 0 });
  });

  it('fills once when the tags agree', () => {
    addGlossaryEntry(ecommerce, 'Save', 'Kaydet');
    addGlossaryEntry(forms, 'Save', 'Kaydet');
    const projectId = addProject([{ msgid: 'Save' }], [ecommerce, forms]);

    expect(applyGlossary(db, projectId)).toEqual({ filled: 1, alternatives: 0, unmatched: 0 });
  });

  it('carries the plural translation', () => {
    addGlossaryEntry(ecommerce, '%d item', '%d ürün', {
      msgidPlural: '%d items',
      translationPlural: '%d ürün',
    });
    const projectId = addProject([{ msgid: '%d item', msgidPlural: '%d items' }], [ecommerce]);

    applyGlossary(db, projectId);
    expect(unitFor(projectId, '%d item')).toMatchObject({
      msgstr: '%d ürün',
      msgstrPlural: '%d ürün',
    });
  });

  it('matches nothing when the project has no tags', () => {
    addGlossaryEntry(ecommerce, 'Save', 'Kaydet');
    const projectId = addProject([{ msgid: 'Save' }], []);

    expect(applyGlossary(db, projectId)).toEqual({ filled: 0, alternatives: 0, unmatched: 1 });
  });

  it('leaves already-settled units alone on a second run', () => {
    addGlossaryEntry(ecommerce, 'Save', 'Kaydet');
    const projectId = addProject([{ msgid: 'Save' }], [ecommerce]);

    applyGlossary(db, projectId);
    expect(applyGlossary(db, projectId)).toEqual({ filled: 0, alternatives: 0, unmatched: 0 });
  });

  it('places filled units into review state when requested', () => {
    addGlossaryEntry(ecommerce, 'Save', 'Kaydet');
    const projectId = addProject([{ msgid: 'Save' }], [ecommerce]);

    const result = applyGlossary(db, projectId, { state: 'review' });
    expect(result).toEqual({ filled: 1, alternatives: 0, unmatched: 0 });
    expect(unitFor(projectId, 'Save')).toMatchObject({
      state: 'review',
      provenance: 'glossary',
      msgstr: 'Kaydet',
    });
  });

  it('matches core wordpress entries for a project with only a specific tag like theme', () => {
    const themeTag = addTag('theme');
    const wpTag = defaultTagId(db);
    addGlossaryEntry(wpTag, 'Read more', 'Devamını oku');
    const projectId = addProject([{ msgid: 'Read more' }], [themeTag]);

    const result = applyGlossary(db, projectId, { state: 'review' });
    expect(result.filled).toBe(1);
    expect(unitFor(projectId, 'Read more')).toMatchObject({
      state: 'review',
      provenance: 'glossary',
      msgstr: 'Devamını oku',
    });
  });

  it('matches across any tag when fallbackAnyTag is true, prioritizing project tags', () => {
    const themeTag = addTag('theme');
    const metaTag = addTag('meta');
    addGlossaryEntry(metaTag, 'Back to top', 'Üste dön');
    addGlossaryEntry(themeTag, 'Back to top', 'Yukarı dön');
    addGlossaryEntry(metaTag, 'Guidelines', 'Yönergeler');
    const projectId = addProject(
      [{ msgid: 'Back to top' }, { msgid: 'Guidelines' }],
      [themeTag],
    );

    const result = applyGlossary(db, projectId, { state: 'review', fallbackAnyTag: true });
    expect(result.filled).toBe(2);
    // themeTag should win over metaTag for 'Back to top'
    expect(unitFor(projectId, 'Back to top')?.msgstr).toBe('Yukarı dön');
    // metaTag should be matched as fallback for 'Guidelines'
    expect(unitFor(projectId, 'Guidelines')?.msgstr).toBe('Yönergeler');
  });

  it('allows filling specific units when ids are given even if not untranslated', () => {
    addGlossaryEntry(ecommerce, 'Save', 'Kaydet');
    const projectId = addProject([{ msgid: 'Save' }], [ecommerce]);
    // Simulate unit already in review
    db.prepare(`UPDATE translation_units SET state = 'review', msgstr = 'Geçici' WHERE project_id = ?`).run(projectId);
    const unitId = (db.prepare(`SELECT id FROM translation_units WHERE project_id = ?`).get(projectId) as { id: number }).id;

    const result = applyGlossary(db, projectId, { ids: [unitId], state: 'review' });
    expect(result.filled).toBe(1);
    expect(unitFor(projectId, 'Save')?.msgstr).toBe('Kaydet');
  });

  it('never overwrites already approved (ok) units even if ids are given', () => {
    addGlossaryEntry(ecommerce, 'Save', 'Kaydet');
    const projectId = addProject([{ msgid: 'Save' }], [ecommerce]);
    db.prepare(`UPDATE translation_units SET state = 'ok', msgstr = 'Özel Çeviri' WHERE project_id = ?`).run(projectId);
    const unitId = (db.prepare(`SELECT id FROM translation_units WHERE project_id = ?`).get(projectId) as { id: number }).id;

    const result = applyGlossary(db, projectId, { ids: [unitId], state: 'review' });
    expect(result.filled).toBe(0);
    expect(unitFor(projectId, 'Save')?.msgstr).toBe('Özel Çeviri');
    expect(unitFor(projectId, 'Save')?.state).toBe('ok');
  });

  it('respects qa_exceptions so known overrides are not marked blocked', () => {
    // A string with a printf discrepancy
    addGlossaryEntry(ecommerce, 'Page %1$d of %2$d', 'Sayfa %d / %d');
    const projectId = addProject([{ msgid: 'Page %1$d of %2$d' }], [ecommerce]);
    const unitId = (db.prepare(`SELECT id FROM translation_units WHERE project_id = ?`).get(projectId) as { id: number }).id;
    // Add QA exception for the rule
    db.prepare(`INSERT INTO qa_exceptions (unit_id, rule, reason) VALUES (?, 'printf_count', 'Bilinçli tercih')`).run(unitId);

    applyGlossary(db, projectId, { ids: [unitId], state: 'review' });
    const unit = db.prepare(`SELECT blocked, state, msgstr FROM translation_units WHERE id = ?`).get(unitId) as { blocked: number; state: string; msgstr: string };
    expect(unit.blocked).toBe(0);
    expect(unit.state).toBe('review');
    expect(unit.msgstr).toBe('Sayfa %d / %d');
  });
});

/** A trusted source at an explicit rank, so ordering tests say what they mean. */
function rank(label: string, position: number): void {
  db.prepare(
    `INSERT INTO trusted_sources (translate_url, family, project_path, label, rank)
     VALUES (?, 'plugin', ?, ?, ?)`,
  ).run(label, label, label, position);
}

/** An entry backed by named trusted sources, created at the next free rank. */
function vouched(tagId: number, msgid: string, translation: string, sources: string[]): void {
  db.prepare(
    `INSERT INTO glossary_entries
       (source_hash, source_text, msgctxt, tag_id, translation, origin)
     VALUES (?, ?, NULL, ?, ?, 'trusted')`,
  ).run(sourceHash(msgid, undefined), msgid, tagId, translation);
  const entryId = db.prepare(`SELECT max(id) AS id FROM glossary_entries`).get() as { id: number };

  for (const label of sources) {
    const existing = db.prepare(`SELECT id FROM trusted_sources WHERE label = ?`).get(label) as
      | { id: number }
      | undefined;
    const sourceId =
      existing?.id ??
      Number(
        db
          .prepare(
            `INSERT INTO trusted_sources (translate_url, family, project_path, label, rank)
             VALUES (?, 'plugin', ?, ?, (SELECT count(*) + 1 FROM trusted_sources))`,
          )
          .run(label, label, label).lastInsertRowid,
      );
    db.prepare(
      `INSERT INTO glossary_entry_sources (entry_id, trusted_source_id, translation, last_seen_sync_id)
       VALUES (?, ?, ?, 1)`,
    ).run(entryId.id, sourceId, translation);
  }
}
