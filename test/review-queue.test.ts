import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { importProject } from '../src/project/import.ts';
import { bulkSetState, listUnits, saveUnit } from '../src/server/review.ts';
import type { Catalogue, TranslationUnit } from '../src/po/types.ts';

const catalogue = (units: Partial<TranslationUnit>[]): Catalogue => ({
  headers: {},
  units: units.map((u, ordinal) => ({ ordinal, msgid: '', ...u }) as TranslationUnit),
});

let db: Db;
let projectId: number;

const add = (units: Partial<TranslationUnit>[]): number =>
  importProject(
    db,
    { family: 'meta', projectPath: `p${Math.random()}`, translateUrl: `t${Math.random()}` },
    catalogue(units),
  );

beforeEach(() => {
  db = openDb(':memory:');
});

describe('importing what the service already translated', () => {
  beforeEach(() => {
    // The shape of a real export: most strings done, some not, one done badly.
    projectId = add([
      { msgid: 'Save', msgstr: 'Kaydet' },
      { msgid: 'Cancel', msgstr: 'İptal' },
      { msgid: 'Delete' },
      { msgid: 'Add' },
      { msgid: 'Use %1$s and %2$s', msgstr: 'Yalnızca %s kullan' },
    ]);
  });

  it('keeps a translation the export carried instead of dropping it', () => {
    // `meta/wordcamp` arrived as 3 116 untranslated strings when 2 413 of them
    // were already done, because the importer inserted no msgstr at all.
    const { counts } = listUnits(db, projectId);

    expect(counts.translated).toBe(3);
    expect(counts.untranslated).toBe(2);
  });

  it('marks it as the service’s work, not the owner’s', () => {
    expect(listUnits(db, projectId, { view: 'upstream' }).total).toBe(3);
  });

  it('does not take an upstream translation on trust', () => {
    // Measured on bbPress: one approved translation renders `,` as a space, and
    // eight of wordcamp's 2 413 fail a check. Upstream approval is not a reason
    // to skip them — these are exactly what a GTE is looking for.
    const blocked = listUnits(db, projectId, { view: 'blocked' });

    expect(blocked.total).toBe(1);
    expect(blocked.rows[0]!.msgid).toBe('Use %1$s and %2$s');
    expect(blocked.rows[0]!.failures).not.toHaveLength(0);
  });
});

describe('paging the queue', () => {
  beforeEach(() => {
    projectId = add(
      Array.from({ length: 250 }, (_, i) => ({ msgid: `string ${i}`, msgstr: `dizge ${i}` })),
    );
  });

  it('returns one page and the total, not the whole catalogue', () => {
    // It used to load and enrich every row, then slice in JS.
    const page = listUnits(db, projectId, { limit: 100, offset: 0 });

    expect(page.rows).toHaveLength(100);
    expect(page.total).toBe(250);
  });

  it('keeps catalogue order across pages', () => {
    const first = listUnits(db, projectId, { limit: 100, offset: 0 });
    const second = listUnits(db, projectId, { limit: 100, offset: 100 });

    expect(first.rows[0]!.msgid).toBe('string 0');
    expect(second.rows[0]!.msgid).toBe('string 100');
  });

  it('counts the filter, not the page', () => {
    const page = listUnits(db, projectId, { search: 'string 1', limit: 10 });

    expect(page.rows).toHaveLength(10);
    expect(page.total).toBeGreaterThan(10);
  });
});

describe('approving and rejecting a whole filter', () => {
  beforeEach(() => {
    projectId = add([
      { msgid: 'One', msgstr: 'Bir' },
      { msgid: 'Two', msgstr: 'İki' },
      { msgid: 'Bad %1$s %2$s', msgstr: 'Kötü %s' },
      { msgid: 'Empty' },
    ]);
    // Put the three translated ones back into review, as an AI run would.
    db.prepare(`UPDATE translation_units SET state = 'review' WHERE msgstr IS NOT NULL`).run();
  });

  it('approves what the checks pass and skips what they block', () => {
    const result = bulkSetState(db, projectId, { view: 'waiting' }, 'approve');

    expect(result).toEqual({ changed: 2, skipped: 1 });
    expect(listUnits(db, projectId, { view: 'blocked' }).total).toBe(1);
  });

  it('empties a rejected unit and sends it back to untranslated', () => {
    // So it exports nothing and the next translation run picks it up.
    bulkSetState(db, projectId, { view: 'waiting' }, 'reject');

    const page = listUnits(db, projectId, { view: 'untranslated' });
    expect(page.total).toBe(4);
    expect(page.rows.every((row) => row.msgstr === null)).toBe(true);
  });

  it('touches only what the filter matches', () => {
    bulkSetState(db, projectId, { view: 'waiting', search: 'One' }, 'approve');

    expect(listUnits(db, projectId, { view: 'translated' }).total).toBe(1);
    expect(listUnits(db, projectId, { view: 'waiting' }).total).toBe(2);
  });
});

describe('a doubtful upstream translation', () => {
  it('arrives untranslated rather than as somebody’s approved work', () => {
    // GlotPress hides fuzzy behind an export filter, but it does not hide the
    // consequence: in the unfiltered export a fuzzy entry carries no msgstr at
    // all. Measured on bbPress, all 11 of them. So it is redone rather than
    // quietly accepted, and no second request is needed to find that out (R32).
    projectId = add([
      { msgid: 'Use %1$s and %2$s' },
      { msgid: 'Fine', msgstr: 'İyi' },
    ]);

    const counts = listUnits(db, projectId).counts;
    expect(counts.untranslated).toBe(1);
    expect(counts.upstream).toBe(1);
  });
});

describe('the blocked column', () => {
  it('follows an edit rather than being recomputed per row', () => {
    // The queue filters and pages on it in SQL; recomputing is what forced the
    // screen to load every row.
    projectId = add([{ msgid: '%1$s and %2$s', msgstr: 'doğru %1$s ve %2$s' }]);
    const unitId = listUnits(db, projectId).rows[0]!.id;

    expect(listUnits(db, projectId, { view: 'blocked' }).total).toBe(0);

    saveUnit(db, unitId, { msgstr: 'tek %s' });
    expect(listUnits(db, projectId, { view: 'blocked' }).total).toBe(1);

    saveUnit(db, unitId, { msgstr: 'yeniden %1$s ve %2$s' });
    expect(listUnits(db, projectId, { view: 'blocked' }).total).toBe(0);
  });
});
