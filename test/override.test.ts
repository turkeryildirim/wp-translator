import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { importProject } from '../src/project/import.ts';
import { listUnits, overrideCheck, saveUnit } from '../src/server/review.ts';
import type { Catalogue, TranslationUnit } from '../src/po/types.ts';

const catalogue = (units: Partial<TranslationUnit>[]): Catalogue => ({
  headers: {},
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
    // bbPress ships this shape: two placeholders in the source, one in the
    // translation. GlotPress calls it fuzzy; the checks call it broken.
    catalogue([{ msgid: 'Use %1$s and %2$s', msgstr: 'Yalnızca %s kullan' }]),
  );
  unitId = listUnits(db, projectId).rows[0]!.id;
});

describe('getting past a blocked string', () => {
  it('is blocked until something changes', () => {
    const page = listUnits(db, projectId, { view: 'blocked' });
    expect(page.total).toBe(1);
    expect(page.rows[0]!.failures).not.toHaveLength(0);
  });

  it('clears when the translation is fixed', () => {
    const { blocked } = saveUnit(db, unitId, { msgstr: 'Hem %1$s hem %2$s kullan' }, true);

    expect(blocked).toBeUndefined();
    expect(listUnits(db, projectId, { view: 'blocked' }).total).toBe(0);
    expect(listUnits(db, projectId, { view: 'translated' }).total).toBe(1);
  });

  it('clears when the owner overrides the rule instead', () => {
    // The other way out, for a check that is wrong about this string.
    const rule = listUnits(db, projectId).rows[0]!.failures[0]!.rule;
    overrideCheck(db, unitId, rule, 'Kaynak hatalı, çeviri doğru.');

    // Saving again is what re-judges the unit without that rule.
    saveUnit(db, unitId, {});
    expect(listUnits(db, projectId, { view: 'blocked' }).total).toBe(0);
  });

  it('keeps the override to that one rule on that one string', () => {
    const rule = listUnits(db, projectId).rows[0]!.failures[0]!.rule;
    overrideCheck(db, unitId, rule, 'sebep');
    saveUnit(db, unitId, {});

    // A different fault on the same string still blocks it.
    saveUnit(db, unitId, { msgstr: '  Yalnızca %s kullan  ' });
    expect(listUnits(db, projectId, { view: 'blocked' }).total).toBe(1);
  });
});
