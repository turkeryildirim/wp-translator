import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { importProject } from '../src/project/import.ts';
import { listUnits, saveUnit } from '../src/server/review.ts';
import { exportProject } from '../src/project/export.ts';
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
    const { blocked } = saveUnit(db, unitId, {
      msgstr: 'Konuşmacı',
      msgstrPlural: 'Konuşmacılar',
    });

    expect(blocked).toBeUndefined();
    expect(listUnits(db, projectId, { view: 'translated' }).total).toBe(1);
  });

  it('carries both forms out to the PO', () => {
    saveUnit(db, unitId, { msgstr: 'Konuşmacı', msgstrPlural: 'Konuşmacılar' });
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
    saveUnit(db, unitId, { msgstr: 'Konuşmacı', msgstrPlural: 'Konuşmacılar' });
    expect(listUnits(db, projectId, { view: 'translated' }).total).toBe(1);

    const { unit } = saveUnit(db, unitId, { msgstr: '', msgstrPlural: '' });

    expect(unit.state).toBe('untranslated');
    expect(unit.msgstr).toBeNull();
    expect(unit.msgstrPlural).toBeNull();
    expect(listUnits(db, projectId, { view: 'untranslated' }).total).toBe(1);
  });
});
