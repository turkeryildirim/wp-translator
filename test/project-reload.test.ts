import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { importProject } from '../src/project/import.ts';
import { ownWork, reloadProject } from '../src/server/projects.ts';
import { listUnits, saveUnit } from '../src/server/review.ts';
import type { Catalogue, TranslationUnit } from '../src/po/types.ts';

const catalogue = (units: Partial<TranslationUnit>[]): Catalogue => ({
  headers: {},
  units: units.map((u, ordinal) => ({ ordinal, msgid: '', ...u }) as TranslationUnit),
});

const po = (units: { id: string; str?: string }[]): string =>
  ['msgid ""', 'msgstr ""', '']
    .concat(units.flatMap((u) => [`msgid "${u.id}"`, `msgstr "${u.str ?? ''}"`, '']))
    .join('\n');

let db: Db;
let projectId: number;

const serve = (body: string): void => {
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(body, { status: 200 })));
};

beforeEach(() => {
  db = openDb(':memory:');
  projectId = importProject(
    db,
    { family: 'meta', projectPath: 'meta/demo', translateUrl: 'u' },
    catalogue([{ msgid: 'Save' }, { msgid: 'Cancel', msgstr: 'İptal' }]),
  );
});

describe('reloading a project from the service', () => {
  it('takes the catalogue the service has now', async () => {
    // Strings are added and withdrawn upstream; the only way to see that is to
    // fetch it again.
    serve(po([{ id: 'Save', str: 'Kaydet' }, { id: 'New string' }]));
    const result = await reloadProject(db, projectId);

    expect(result.strings).toBe(2);
    const rows = listUnits(db, projectId).rows.map((row) => row.msgid);
    expect(rows).toEqual(['Save', 'New string']);
    expect(rows).not.toContain('Cancel');
  });

  it('counts the owner’s work before discarding it', async () => {
    // The warning names a number rather than a risk, and it has to be the real
    // one — the owner is deciding whether they have exported yet.
    const unitId = listUnits(db, projectId, { view: 'untranslated' }).rows[0]!.id;
    saveUnit(db, unitId, { msgstr: 'Kaydet' });
    expect(ownWork(db, projectId)).toBe(1);

    serve(po([{ id: 'Save' }]));
    const result = await reloadProject(db, projectId);

    expect(result.discarded).toBe(1);
    expect(listUnits(db, projectId, { view: 'untranslated' }).total).toBe(1);
  });

  it('keeps the project itself, so tags and the owner’s place survive', async () => {
    serve(po([{ id: 'Save' }]));
    const result = await reloadProject(db, projectId);

    expect(result.strings).toBe(1);
    expect(
      (db.prepare(`SELECT count(*) AS n FROM projects`).get() as { n: number }).n,
    ).toBe(1);
  });

  it('refuses an empty catalogue instead of emptying the project', async () => {
    // An empty export is what a moved or renamed project looks like. Obeying it
    // would discard everything and report success.
    serve(po([]));

    await expect(reloadProject(db, projectId)).rejects.toThrow(/empty catalogue/);
    expect(listUnits(db, projectId).total).toBe(2);
  });
});
