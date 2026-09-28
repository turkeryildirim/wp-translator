import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { importProject } from '../src/project/import.ts';
import { bulkSetState, listUnits, replaceInTranslations } from '../src/server/review.ts';
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

const unit = (msgid: string) =>
  listUnits(db, projectId, { view: 'all', limit: 100, offset: 0 }).rows.find(
    (row) => row.msgid === msgid,
  )!;

beforeEach(() => {
  db = openDb(':memory:');
});

describe('replacing text across translations', () => {
  beforeEach(() => {
    projectId = add([
      { msgid: 'Plugin settings', msgstr: 'Eklenti ayarları' },
      { msgid: 'Install plugin', msgstr: 'Eklenti kur' },
      { msgid: 'Plugin', msgstr: 'eklenti' },
      { msgid: 'Theme', msgstr: 'Tema' },
      { msgid: 'Untouched', msgstr: null as unknown as string },
    ]);
  });

  it('rewrites every translation in scope, not only the page on screen', () => {
    const result = replaceInTranslations(db, projectId, { filter: { view: 'all' } }, 'Eklenti', 'Uzantı');

    expect(result).toMatchObject({ matched: 2, changed: 2 });
    expect(unit('Plugin settings').msgstr).toBe('Uzantı ayarları');
    expect(unit('Install plugin').msgstr).toBe('Uzantı kur');
  });

  it('is case sensitive, because thousands of rows are rewritten at once', () => {
    // `eklenti` in the third row is not `Eklenti`, and a loose match is how the
    // wrong rows get rewritten.
    replaceInTranslations(db, projectId, { filter: { view: 'all' } }, 'Eklenti', 'Uzantı');

    expect(unit('Plugin').msgstr).toBe('eklenti');
  });

  it('matches Turkish letters as themselves', () => {
    // `İ` and `ı` are distinct letters, not case variants of `i`, and a fold that
    // treats them otherwise rewrites words it was never pointed at.
    projectId = add([
      { msgid: 'a', msgstr: 'İÇERİK listesi' },
      { msgid: 'b', msgstr: 'içerik listesi' },
      { msgid: 'c', msgstr: 'ışık' },
    ]);

    replaceInTranslations(db, projectId, { filter: { view: 'all' } }, 'İÇERİK', 'BÖLÜM');

    expect(unit('a').msgstr).toBe('BÖLÜM listesi');
    expect(unit('b').msgstr).toBe('içerik listesi');
    expect(unit('c').msgstr).toBe('ışık');
  });

  it('never touches the source', () => {
    replaceInTranslations(db, projectId, { filter: { view: 'all' } }, 'Plugin', 'Uzantı');

    expect(unit('Plugin settings').msgid).toBe('Plugin settings');
  });

  it('counts without writing when asked to preview', () => {
    const result = replaceInTranslations(
      db, projectId, { filter: { view: 'all' } }, 'Eklenti', 'Uzantı', true,
    );

    expect(result).toMatchObject({ matched: 2, changed: 0 });
    expect(unit('Plugin settings').msgstr).toBe('Eklenti ayarları');
  });

  it('honours a narrowed scope, so a search decides what is rewritten', () => {
    const only = unit('Install plugin').id;

    const result = replaceInTranslations(db, projectId, { ids: [only] }, 'Eklenti', 'Uzantı');

    expect(result.changed).toBe(1);
    expect(unit('Plugin settings').msgstr).toBe('Eklenti ayarları');
  });

  it('sends what it rewrote back to review, as editing one by hand does', () => {
    bulkSetState(db, projectId, { filter: { view: 'all' } }, 'approve');
    expect(unit('Plugin settings').state).toBe('ok');

    replaceInTranslations(db, projectId, { filter: { view: 'all' } }, 'Eklenti', 'Uzantı');

    // The approved text is not the text any more, so it is not approved either.
    expect(unit('Plugin settings').state).toBe('review');
    expect(unit('Theme').state).toBe('ok');
  });

  it('reports what the checks now refuse rather than writing it silently', () => {
    projectId = add([{ msgid: 'Use %s now', msgstr: 'Şimdi %s kullan' }]);

    const result = replaceInTranslations(db, projectId, { filter: { view: 'all' } }, '%s', 'bunu');

    expect(result).toMatchObject({ changed: 1, blocked: 1 });
    // Written, but carrying the reason it cannot be approved.
    expect(unit('Use %s now').failures.map((failure) => failure.rule)).toContain(
      'printf-placeholders',
    );
  });

  it('refuses an empty search, which would match every position', () => {
    expect(() =>
      replaceInTranslations(db, projectId, { filter: { view: 'all' } }, '', 'x'),
    ).toThrow(/boş/);
  });
});
