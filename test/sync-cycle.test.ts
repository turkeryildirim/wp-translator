import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { collapseAgreedContexts } from '../src/glossary/collapse.ts';
import { syncTrustedSource } from '../src/glossary/sync.ts';
import type { Catalogue, TranslationUnit } from '../src/po/types.ts';

const catalogue = (units: Partial<TranslationUnit>[]): Catalogue => ({
  headers: {},
  units: units.map((u, ordinal) => ({ ordinal, msgid: '', ...u }) as TranslationUnit),
});

let db: Db;
let tagId: number;
let bp: number;
let core: number;

const bpCatalogue = catalogue([
  { msgid: '&larr;', msgctxt: 'Activity pagination previous text', msgstr: '&larr;' },
  { msgid: '&larr;', msgctxt: 'Group pagination previous text', msgstr: '&larr;' },
]);
const coreCatalogue = catalogue([{ msgid: '&larr;', msgctxt: 'Previous post link', msgstr: '&larr;' }]);

const addSource = (label: string, rank: number): number =>
  Number(
    db
      .prepare(
        `INSERT INTO trusted_sources (translate_url, family, project_path, label, rank)
         VALUES (?, 'plugin', ?, ?, ?)`,
      )
      .run(label, label, label, rank).lastInsertRowid,
  );

const arrow = () =>
  db.prepare(`SELECT id, msgctxt FROM glossary_entries WHERE source_text = '&larr;'`).all() as {
    id: number;
    msgctxt: string | null;
  }[];

function fullUpdate(): number {
  syncTrustedSource(db, bp, bpCatalogue, [tagId]);
  syncTrustedSource(db, core, coreCatalogue, [tagId]);
  return collapseAgreedContexts(db);
}

beforeEach(() => {
  db = openDb(':memory:');
  tagId = Number(db.prepare(`INSERT INTO tags (name) VALUES ('general')`).run().lastInsertRowid);
  bp = addSource('buddypress', 1);
  core = addSource('core', 2);
});

describe('a merged row across repeated updates', () => {
  it('is merged once and then left alone', () => {
    expect(fullUpdate()).toBe(2);
    expect(arrow()).toEqual([{ id: expect.any(Number), msgctxt: null }]);

    // The second update re-imports the same contexts. If the sync re-creates a
    // row per context, the merge has to be redone every time and the survivor
    // loses the vouches that keep it alive.
    expect(fullUpdate()).toBe(0);
  });

  it('keeps its identity, so a unit filled from it keeps its provenance', () => {
    fullUpdate();
    const first = arrow()[0]!.id;

    fullUpdate();
    expect(arrow().map((row) => row.id)).toEqual([first]);
  });
});
