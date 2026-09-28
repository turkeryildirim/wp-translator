import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { syncTrustedSource } from '../src/glossary/sync.ts';
import type { Catalogue, TranslationUnit } from '../src/po/types.ts';

const catalogue = (units: Partial<TranslationUnit>[]): Catalogue => ({
  headers: {},
  units: units.map((u, ordinal) => ({ ordinal, msgid: '', ...u }) as TranslationUnit),
});

let db: Db;
let coreId: number;
let wooId: number;
let tagId: number;

const addSource = (label: string, rank: number): number =>
  Number(
    db
      .prepare(
        `INSERT INTO trusted_sources (translate_url, family, project_path, label, rank)
         VALUES (?, 'plugin', ?, ?, ?)`,
      )
      .run(label, label, label, rank).lastInsertRowid,
  );

const lookup = (msgid: string) =>
  db.prepare(`SELECT translation FROM glossary_entries WHERE source_text = ?`).get(msgid) as
    | { translation: string }
    | undefined;

const translationsOf = (msgid: string): string[] =>
  db
    .prepare(`SELECT translation FROM glossary_entries WHERE source_text = ? ORDER BY id`)
    .all(msgid)
    .map((row) => (row as { translation: string }).translation);

const countLinks = (msgid: string): number =>
  (
    db
      .prepare(
        `SELECT count(*) AS n FROM glossary_entry_sources s
           JOIN glossary_entries g ON g.id = s.entry_id
          WHERE g.source_text = ?`,
      )
      .get(msgid) as { n: number }
  ).n;

beforeEach(() => {
  db = openDb(':memory:');
  tagId = Number(db.prepare(`INSERT INTO tags (name) VALUES ('general')`).run().lastInsertRowid);
  coreId = addSource('core', 1);
  wooId = addSource('woocommerce', 2);
});

describe('trusted-source sync', () => {
  it('adds translated entries and skips untranslated ones', () => {
    const result = syncTrustedSource(
      db,
      coreId,
      catalogue([
        { msgid: 'Save', msgstr: 'Kaydet' },
        { msgid: 'Untranslated' },
      ]),
      [tagId],
    );

    expect(result.entriesSeen).toBe(1);
    expect(lookup('Save')?.translation).toBe('Kaydet');
    expect(lookup('Untranslated')).toBeUndefined();
  });

  it('keeps distinct translations apart and records where each was seen', () => {
    // WordPress core translates "May" as the month and as its abbreviation.
    // Two wordings are two entries; the contexts ride along as a note.
    syncTrustedSource(
      db,
      coreId,
      catalogue([
        { msgid: 'May', msgstr: 'Mayıs' },
        { msgid: 'May', msgctxt: 'May abbreviation', msgstr: 'May' },
      ]),
      [tagId],
    );

    const rows = db
      .prepare(
        `SELECT g.translation,
                (SELECT group_concat(msgctxt) FROM glossary_entry_contexts c
                  WHERE c.entry_id = g.id) AS contexts
           FROM glossary_entries g WHERE g.source_text = 'May' ORDER BY g.id`,
      )
      .all() as { translation: string; contexts: string | null }[];

    expect(rows).toEqual([
      { translation: 'Mayıs', contexts: null },
      { translation: 'May', contexts: 'May abbreviation' },
    ]);
  });

  it('writes one row per project tag', () => {
    const second = Number(
      db.prepare(`INSERT INTO tags (name) VALUES ('ecommerce')`).run().lastInsertRowid,
    );
    syncTrustedSource(db, coreId, catalogue([{ msgid: 'Save', msgstr: 'Kaydet' }]), [tagId, second]);

    expect(
      (db.prepare(`SELECT count(*) AS n FROM glossary_entries`).get() as { n: number }).n,
    ).toBe(2);
  });

  it('updates a translation the same source changed', () => {
    syncTrustedSource(db, coreId, catalogue([{ msgid: 'Save', msgstr: 'Kaydet' }]), [tagId]);
    syncTrustedSource(db, coreId, catalogue([{ msgid: 'Save', msgstr: 'Sakla' }]), [tagId]);

    expect(lookup('Save')?.translation).toBe('Sakla');
    expect(countLinks('Save')).toBe(1);
  });

  it('removes an entry the source stopped carrying', () => {
    syncTrustedSource(db, coreId, catalogue([{ msgid: 'Gone', msgstr: 'Gitti' }]), [tagId]);
    const result = syncTrustedSource(db, coreId, catalogue([]), [tagId]);

    expect(result.linksRemoved).toBe(1);
    expect(result.entriesRemoved).toBe(1);
    expect(lookup('Gone')).toBeUndefined();
  });

  it('keeps an entry a second source still vouches for', () => {
    // A single owner column cannot express this, and sharing is the normal case.
    syncTrustedSource(db, coreId, catalogue([{ msgid: 'Save', msgstr: 'Kaydet' }]), [tagId]);
    syncTrustedSource(db, wooId, catalogue([{ msgid: 'Save', msgstr: 'Kaydet' }]), [tagId]);
    expect(countLinks('Save')).toBe(2);

    syncTrustedSource(db, wooId, catalogue([]), [tagId]);

    expect(lookup('Save')?.translation).toBe('Kaydet');
    expect(countLinks('Save')).toBe(1);
  });

  it('stores both readings rather than choosing between them', () => {
    // Choosing is matching's job, where the owner can see the alternatives and
    // override them. Storing a winner here would hide the other reading.
    syncTrustedSource(db, coreId, catalogue([{ msgid: 'Save', msgstr: 'Kaydet' }]), [tagId]);
    syncTrustedSource(db, wooId, catalogue([{ msgid: 'Save', msgstr: 'Sakla' }]), [tagId]);

    expect(translationsOf('Save')).toEqual(['Kaydet', 'Sakla']);
  });

  it('records the same reading once however many sources carry it', () => {
    syncTrustedSource(db, coreId, catalogue([{ msgid: 'Save', msgstr: 'Kaydet' }]), [tagId]);
    syncTrustedSource(db, wooId, catalogue([{ msgid: 'Save', msgstr: 'Kaydet' }]), [tagId]);

    expect(translationsOf('Save')).toEqual(['Kaydet']);
    expect(countLinks('Save')).toBe(2);
  });



  it('leaves an entry the owner approved even when no source carries it', () => {
    db.prepare(
      `INSERT INTO glossary_entries (source_hash, source_text, tag_id, translation, origin)
       VALUES ('owner-hash', 'Mine', ?, 'Benim', 'owner')`,
    ).run(tagId);

    syncTrustedSource(db, coreId, catalogue([]), [tagId]);

    expect(lookup('Mine')?.translation).toBe('Benim');
  });

  it('records the run', () => {
    const { syncRunId } = syncTrustedSource(
      db,
      coreId,
      catalogue([{ msgid: 'Save', msgstr: 'Kaydet' }]),
      [tagId],
    );
    const run = db.prepare(`SELECT status, entries_seen FROM sync_runs WHERE id = ?`).get(syncRunId);

    expect(run).toEqual({ status: 'ok', entries_seen: 1 });
    expect(
      (db.prepare(`SELECT last_sync_id AS id FROM trusted_sources WHERE id = ?`).get(coreId) as {
        id: number;
      }).id,
    ).toBe(syncRunId);
  });
});

describe('what a sync stores', () => {
  it('keeps the words and drops the surrounding whitespace', () => {
    // Otherwise the glossary fills with rows that say the same thing in a
    // different shape.
    syncTrustedSource(
      db,
      coreId,
      catalogue([{ msgid: '  Save \n', msgstr: '\tKaydet ' }]),
      [tagId],
    );

    const row = db
      .prepare(`SELECT source_text, translation FROM glossary_entries`)
      .get() as { source_text: string; translation: string };

    expect(row).toEqual({ source_text: 'Save', translation: 'Kaydet' });
  });

  it('meets a differently padded source on one row', () => {
    syncTrustedSource(db, coreId, catalogue([{ msgid: 'Save ', msgstr: 'Kaydet' }]), [tagId]);
    syncTrustedSource(db, wooId, catalogue([{ msgid: '\nSave', msgstr: ' Kaydet ' }]), [tagId]);

    expect(translationsOf('Save')).toEqual(['Kaydet']);
    expect(countLinks('Save')).toBe(2);
  });

  it('leaves a string that is only whitespace out', () => {
    // There is nothing to learn from it, and it has no core to key on.
    syncTrustedSource(db, coreId, catalogue([{ msgid: '   ', msgstr: '   ' }]), [tagId]);

    expect(
      (db.prepare(`SELECT count(*) AS n FROM glossary_entries`).get() as { n: number }).n,
    ).toBe(0);
  });
});

describe('what a run reports', () => {
  it('counts entries it created, not entries the source carries', () => {
    // A source that has not changed upstream adds nothing. Without this number
    // that run is indistinguishable from one that never happened, which is how
    // "the entry count does not move" gets read as a broken button.
    const db = openDb(':memory:');
    const tagId = (db.prepare(`SELECT id FROM tags WHERE name = 'wordpress'`).get() as { id: number })
      .id;
    const sourceId = Number(
      db
        .prepare(
          `INSERT INTO trusted_sources (translate_url, family, project_path)
           VALUES ('https://translate.wordpress.org/projects/wp-plugins/x/', 'plugin', 'wp-plugins/x')`,
        )
        .run().lastInsertRowid,
    );
    const catalogue = {
      headers: {},
      units: [
        { ordinal: 0, msgid: 'Save', msgstr: 'Kaydet' },
        { ordinal: 1, msgid: 'Cancel', msgstr: 'İptal' },
      ],
    } as Catalogue;

    const first = syncTrustedSource(db, sourceId, catalogue, [tagId]);
    expect(first).toMatchObject({ entriesSeen: 2, entriesAdded: 2 });

    const again = syncTrustedSource(db, sourceId, catalogue, [tagId]);
    expect(again).toMatchObject({ entriesSeen: 2, entriesAdded: 0 });
  });
})
