import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
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

/** The same string under three different contexts, translated identically. */
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
  db
    .prepare(
      `SELECT id, translation, msgctxt FROM glossary_entries WHERE source_text = '&larr;'`,
    )
    .all() as { id: number; translation: string; msgctxt: string | null }[];

const contexts = (entryId: number): string[] =>
  db
    .prepare(`SELECT msgctxt FROM glossary_entry_contexts WHERE entry_id = ? ORDER BY msgctxt`)
    .all(entryId)
    .map((row) => (row as { msgctxt: string }).msgctxt);

function fullUpdate(): void {
  syncTrustedSource(db, bp, bpCatalogue, [tagId]);
  syncTrustedSource(db, core, coreCatalogue, [tagId]);
}

beforeEach(() => {
  db = openDb(':memory:');
  tagId = Number(db.prepare(`INSERT INTO tags (name) VALUES ('general')`).run().lastInsertRowid);
  bp = addSource('buddypress', 1);
  core = addSource('core', 2);
});

describe('one string arriving under many contexts', () => {
  it('is one entry, whatever the sources called it', () => {
    // `&larr;` came from eight contexts across two projects, all translated the
    // same way. Keyed on context it was eight rows; keyed on the translation it
    // is the single fact it always was (D44).
    fullUpdate();

    expect(arrow()).toEqual([
      { id: expect.any(Number), translation: '&larr;', msgctxt: null },
    ]);
  });

  it('keeps the contexts it was seen under', () => {
    fullUpdate();

    expect(contexts(arrow()[0]!.id)).toEqual([
      'Activity pagination previous text',
      'Group pagination previous text',
      'Previous post link',
    ]);
  });

  it('keeps its identity across repeated updates', () => {
    // An entry re-created each update loses the vouches that keep it alive
    // (R14), is swept, and takes the provenance of every unit filled from it.
    fullUpdate();
    const first = arrow()[0]!.id;

    fullUpdate();
    fullUpdate();

    expect(arrow().map((row) => row.id)).toEqual([first]);
    expect(contexts(first)).toHaveLength(3);
  });

  it('holds both readings when the sources disagree', () => {
    syncTrustedSource(db, bp, catalogue([{ msgid: 'Cancel', msgstr: 'İptal' }]), [tagId]);
    syncTrustedSource(db, core, catalogue([{ msgid: 'Cancel', msgstr: 'Vazgeç' }]), [tagId]);

    const rows = db
      .prepare(`SELECT translation FROM glossary_entries WHERE source_text = 'Cancel' ORDER BY id`)
      .all()
      .map((row) => (row as { translation: string }).translation);
    expect(rows).toEqual(['İptal', 'Vazgeç']);
  });
});
