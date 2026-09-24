import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { applyGlossary } from '../src/glossary/match.ts';
import { importProject, setProjectTags } from '../src/project/import.ts';
import { bulkSetState, listUnits, saveUnit } from '../src/server/review.ts';
import { sourceHash } from '../src/glossary/key.ts';
import type { Catalogue, TranslationUnit } from '../src/po/types.ts';

const catalogue = (units: Partial<TranslationUnit>[]): Catalogue => ({
  headers: {},
  units: units.map((u, ordinal) => ({ ordinal, msgid: '', ...u }) as TranslationUnit),
});

let db: Db;
let projectId: number;
let tagId: number;

const glossarySize = (): number =>
  (db.prepare(`SELECT count(*) AS n FROM glossary_entries`).get() as { n: number }).n;

beforeEach(() => {
  db = openDb(':memory:');
  tagId = Number(db.prepare(`INSERT INTO tags (name) VALUES ('general')`).run().lastInsertRowid);
  db.prepare(
    `INSERT INTO glossary_entries (source_hash, source_text, msgctxt, tag_id, translation, origin)
     VALUES (?, 'Save', NULL, ?, 'Kaydet', 'owner')`,
  ).run(sourceHash('Save', undefined), tagId);

  projectId = importProject(
    db,
    { family: 'meta', projectPath: 'p', translateUrl: 'u' },
    catalogue([{ msgid: 'Save' }, { msgid: 'Delete' }, { msgid: 'Add' }]),
  );
  setProjectTags(db, projectId, [tagId]);
});

/**
 * The glossary holds what humans reviewed and approved on
 * translate.wordpress.org, and that is the whole reason a match from it can be
 * placed without review (D22). A project's own output has not been through
 * that, so it stays out (D23). The way in is to add the project as a trusted
 * source and let the next sync take it.
 */
describe('a project never writes to the glossary', () => {
  it('not when the glossary fills a unit', () => {
    const before = glossarySize();
    expect(applyGlossary(db, projectId).filled).toBe(1);
    expect(glossarySize()).toBe(before);
  });

  it('not when the owner translates a string by hand', () => {
    const before = glossarySize();
    const unitId = listUnits(db, projectId, { view: 'untranslated' }).rows[0]!.id;

    saveUnit(db, unitId, { msgstr: 'Sil' });
    expect(listUnits(db, projectId, { view: 'translated' }).total).toBe(1);
    expect(glossarySize()).toBe(before);
  });

  it('not when a whole filter is approved at once', () => {
    const before = glossarySize();
    for (const row of listUnits(db, projectId, { view: 'untranslated' }).rows) {
      saveUnit(db, row.id, { msgstr: `çeviri ${row.id}` });
    }
    bulkSetState(db, projectId, { filter: { view: 'waiting' } }, 'approve');

    expect(glossarySize()).toBe(before);
  });

  it('not even a translation that contradicts an entry', () => {
    // The collision the register used to describe. There is nothing to resolve:
    // the project keeps its wording, the glossary keeps its own.
    const unitId = listUnits(db, projectId).rows.find((row) => row.msgid === 'Save')!.id;
    saveUnit(db, unitId, { msgstr: 'Sakla' });

    const entry = db
      .prepare(`SELECT translation FROM glossary_entries WHERE source_text = 'Save'`)
      .get() as { translation: string };
    expect(entry.translation).toBe('Kaydet');
    expect(glossarySize()).toBe(1);
  });
});
