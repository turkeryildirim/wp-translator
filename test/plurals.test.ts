import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { importProject } from '../src/project/import.ts';
import { listUnits, saveUnit } from '../src/server/review.ts';
import { exportProject } from '../src/project/export.ts';
import { updateEntry } from '../src/server/glossary.ts';
import { sourceHash } from '../src/glossary/key.ts';
import { parsePo } from '../src/po/parse.ts';
import type { Catalogue, TranslationUnit } from '../src/po/types.ts';

const catalogue = (units: Partial<TranslationUnit>[]): Catalogue => ({
  headers: { 'Plural-Forms': 'nplurals=2; plural=n > 1;' },
  units: units.map((u, ordinal) => ({ ordinal, msgid: '', ...u }) as TranslationUnit),
});

let db: Db;
let projectId: number;
let unitId: number;

beforeEach(() => {
  db = openDb(':memory:');
  projectId = importProject(
    db,
    { family: 'meta', projectPath: 'p', translateUrl: 'u' },
    catalogue([{ msgid: 'Speaker', msgidPlural: 'Speakers' }]),
  );
  unitId = listUnits(db, projectId).rows[0]!.id;
});

describe('a string with singular and plural forms', () => {
  it('is refused while only one form is given', () => {
    const { blocked } = saveUnit(db, unitId, { msgstr: 'Konuşmacı' });

    expect(blocked?.map((failure) => failure.rule)).toEqual(['plural-missing']);
    expect(listUnits(db, projectId, { view: 'blocked' }).total).toBe(1);
  });

  it('settles once both forms are given', () => {
    const { blocked } = saveUnit(
      db,
      unitId,
      { msgstr: 'Konuşmacı', msgstrPlural: 'Konuşmacılar' },
      true,
    );

    expect(blocked).toBeUndefined();
    expect(listUnits(db, projectId, { view: 'translated' }).total).toBe(1);
  });

  it('carries both forms out to the PO', () => {
    saveUnit(db, unitId, { msgstr: 'Konuşmacı', msgstrPlural: 'Konuşmacılar' }, true);
    const unit = parsePo(exportProject(db, projectId).po).units[0]!;

    expect(unit.msgidPlural).toBe('Speakers');
    expect(unit.msgstr).toBe('Konuşmacı');
    expect(unit.msgstrPlural).toBe('Konuşmacılar');
  });
});

describe('emptying a translation', () => {
  it('sends the unit back to untranslated rather than leaving it settled', () => {
    // Rejecting is a save of an empty string; an empty translation is not a
    // translation, so it exports nothing and the next run picks it up.
    saveUnit(db, unitId, { msgstr: 'Konuşmacı', msgstrPlural: 'Konuşmacılar' }, true);
    expect(listUnits(db, projectId, { view: 'translated' }).total).toBe(1);

    const { unit } = saveUnit(db, unitId, { msgstr: '', msgstrPlural: '' });

    expect(unit.state).toBe('untranslated');
    expect(unit.msgstr).toBeNull();
    expect(unit.msgstrPlural).toBeNull();
    expect(listUnits(db, projectId, { view: 'untranslated' }).total).toBe(1);
  });
});

describe('a glossary entry with plural forms', () => {
  let tagId: number;
  let entryId: number;

  beforeEach(() => {
    tagId = Number(db.prepare(`INSERT INTO tags (name) VALUES ('general')`).run().lastInsertRowid);
    entryId = Number(
      db
        .prepare(
          `INSERT INTO glossary_entries
             (source_hash, source_text, source_plural, msgctxt, tag_id, translation,
              translation_plural, origin)
           VALUES (?, '%s speaker', '%s speakers', NULL, ?, '%s konuşmacı', NULL, 'trusted')`,
        )
        .run(sourceHash('%s speaker', '%s speakers'), tagId).lastInsertRowid,
    );
  });

  const stored = () =>
    db
      .prepare(`SELECT translation, translation_plural AS plural FROM glossary_entries WHERE id = ?`)
      .get(entryId) as { translation: string; plural: string | null };

  it('takes a plural translation', () => {
    updateEntry(db, entryId, '%s konuşmacı', '%s konuşmacılar');

    expect(stored()).toEqual({ translation: '%s konuşmacı', plural: '%s konuşmacılar' });
  });

  it('keeps the stored plural when none is sent', () => {
    // A caller editing only the singular must not silently drop the other half.
    updateEntry(db, entryId, '%s konuşmacı', '%s konuşmacılar');
    updateEntry(db, entryId, '%s sunucu');

    expect(stored()).toEqual({ translation: '%s sunucu', plural: '%s konuşmacılar' });
  });

  it('clears the plural when an empty one is sent', () => {
    updateEntry(db, entryId, '%s konuşmacı', '%s konuşmacılar');
    updateEntry(db, entryId, '%s konuşmacı', '');

    expect(stored().plural).toBeNull();
  });

  it('refuses a wording the glossary already holds', () => {
    // Both halves are part of the key, so changing either can collide.
    db.prepare(
      `INSERT INTO glossary_entries
         (source_hash, source_text, source_plural, msgctxt, tag_id, translation,
          translation_plural, origin)
       VALUES (?, '%s speaker', '%s speakers', NULL, ?, '%s sunucu', '%s sunucular', 'trusted')`,
    ).run(sourceHash('%s speaker', '%s speakers'), tagId);

    expect(() => updateEntry(db, entryId, '%s sunucu', '%s sunucular')).toThrow(/zaten var/);
  });
});
