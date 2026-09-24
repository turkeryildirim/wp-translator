import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { collapseAgreedContexts } from '../src/glossary/collapse.ts';
import { applyGlossary } from '../src/glossary/match.ts';
import { sourceHash } from '../src/glossary/key.ts';
import { syncTrustedSource } from '../src/glossary/sync.ts';
import type { Catalogue, TranslationUnit } from '../src/po/types.ts';

const catalogue = (units: Partial<TranslationUnit>[]): Catalogue => ({
  headers: {},
  units: units.map((u, ordinal) => ({ ordinal, msgid: '', ...u }) as TranslationUnit),
});

let db: Db;
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

const rows = (msgid: string) =>
  db
    .prepare(
      `SELECT msgctxt, translation FROM glossary_entries
        WHERE source_text = ? ORDER BY ifnull(msgctxt, '')`,
    )
    .all(msgid) as { msgctxt: string | null; translation: string }[];

/** Distinct (entry, source) vouches, which is what keeps an entry alive (R14). */
const vouches = (msgid: string): string[] =>
  db
    .prepare(
      `SELECT t.label FROM glossary_entry_sources s
         JOIN glossary_entries g ON g.id = s.entry_id
         JOIN trusted_sources t ON t.id = s.trusted_source_id
        WHERE g.source_text = ? ORDER BY t.label`,
    )
    .all(msgid)
    .map((r) => (r as { label: string }).label);

beforeEach(() => {
  db = openDb(':memory:');
  projects = 0;
  tagId = Number(db.prepare(`INSERT INTO tags (name) VALUES ('general')`).run().lastInsertRowid);
});

describe('merging rows that differ only by context', () => {
  it('lets a context-less unit match a string every context agreed on', () => {
    // The bug this prevents: `&larr;` arrived under eight contexts, all
    // translated `&larr;`, and none of them context-less. applyGlossary matches
    // a context-less unit against context-less rows only, so a plain `&larr;`
    // matched nothing while eight rows said the same thing.
    const buddypress = addSource('buddypress', 1);
    syncTrustedSource(
      db,
      buddypress,
      catalogue([
        { msgid: '&larr;', msgctxt: 'Activity pagination previous text', msgstr: '&larr;' },
        { msgid: '&larr;', msgctxt: 'Group pagination previous text', msgstr: '&larr;' },
        { msgid: '&larr;', msgctxt: 'Blog pagination previous text', msgstr: '&larr;' },
      ]),
      [tagId],
    );

    const projectId = project();
    unit('&larr;', null);
    expect(applyGlossary(db, projectId).filled).toBe(0);

    expect(collapseAgreedContexts(db)).toBe(2);
    expect(rows('&larr;')).toEqual([{ msgctxt: null, translation: '&larr;' }]);

    const second = project();
    unit('&larr;', null, second);
    expect(applyGlossary(db, second).filled).toBe(1);
  });

  it('leaves a string whose contexts disagree alone', () => {
    // `Cancel` is `İptal`, `İptal Et` and `Vazgeç` depending on context. That is
    // the distinction msgctxt exists to make; merging it would pick one at
    // random and apply it everywhere.
    const core = addSource('core', 1);
    syncTrustedSource(
      db,
      core,
      catalogue([
        { msgid: 'Cancel', msgctxt: 'button', msgstr: 'Vazgeç' },
        { msgid: 'Cancel', msgctxt: 'dialog_button_cancel', msgstr: 'İptal' },
        { msgid: 'Cancel', msgctxt: 'appUpdate.action.cancel', msgstr: 'İptal Et' },
      ]),
      [tagId],
    );

    expect(collapseAgreedContexts(db)).toBe(0);
    expect(rows('Cancel')).toHaveLength(3);
  });

  it('keeps every vouch when the rows carrying them are merged away', () => {
    // An entry lives while any source still vouches for it (R14). The vouches
    // hang off the rows being deleted, and ON DELETE CASCADE would take them
    // with the row, silently orphaning the survivor into the next sweep.
    const core = addSource('core', 1);
    const woo = addSource('woocommerce', 2);
    syncTrustedSource(db, core, catalogue([{ msgid: 'All', msgctxt: 'a', msgstr: 'Tümü' }]), [tagId]);
    syncTrustedSource(db, woo, catalogue([{ msgid: 'All', msgctxt: 'b', msgstr: 'Tümü' }]), [tagId]);

    expect(vouches('All')).toEqual(['core', 'woocommerce']);
    collapseAgreedContexts(db);

    expect(rows('All')).toHaveLength(1);
    expect(vouches('All')).toEqual(['core', 'woocommerce']);
  });

  it('keeps a filled unit pointing at a row that still exists', () => {
    const core = addSource('core', 1);
    syncTrustedSource(
      db,
      core,
      catalogue([
        { msgid: 'Save', msgctxt: 'x', msgstr: 'Kaydet' },
        { msgid: 'Save', msgctxt: 'y', msgstr: 'Kaydet' },
      ]),
      [tagId],
    );

    const projectId = project();
    unit('Save', 'x');
    expect(applyGlossary(db, projectId).filled).toBe(1);

    collapseAgreedContexts(db);

    const dangling = db
      .prepare(
        `SELECT count(*) AS n FROM translation_units u
          WHERE u.glossary_entry_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM glossary_entries g WHERE g.id = u.glossary_entry_id)`,
      )
      .get() as { n: number };
    expect(dangling.n).toBe(0);
  });

  it('changes nothing on a second run', () => {
    const core = addSource('core', 1);
    syncTrustedSource(
      db,
      core,
      catalogue([
        { msgid: 'Edit', msgctxt: 'p', msgstr: 'Düzenle' },
        { msgid: 'Edit', msgctxt: 'q', msgstr: 'Düzenle' },
      ]),
      [tagId],
    );

    expect(collapseAgreedContexts(db)).toBe(1);
    expect(collapseAgreedContexts(db)).toBe(0);
  });

  it('never merges terminology, whose alternatives are deliberate', () => {
    // The official glossary offers several translations under one part of
    // speech; those rows key on the translation, and matching skips them.
    db.prepare(
      `INSERT INTO glossary_entries
         (source_hash, source_text, msgctxt, tag_id, translation, origin, pos)
       VALUES (?, 'author', NULL, ?, 'yazar', 'trusted', 'noun'),
              (?, 'author', NULL, ?, 'geliştirici', 'trusted', 'noun')`,
    ).run(sourceHash('author', undefined), tagId, sourceHash('author', undefined), tagId);

    expect(collapseAgreedContexts(db)).toBe(0);
    expect(rows('author')).toHaveLength(2);
  });
});

let projects = 0;

function project(): number {
  projects += 1;
  return Number(
    db
      .prepare(`INSERT INTO projects (family, project_path, translate_url) VALUES ('plugin',?,?)`)
      .run(`p${projects}`, `t${projects}`).lastInsertRowid,
  );
}

function unit(msgid: string, msgctxt: string | null, projectId?: number): void {
  const id = projectId ?? (db.prepare(`SELECT max(id) AS id FROM projects`).get() as { id: number }).id;
  db.prepare(`INSERT OR IGNORE INTO project_tags (project_id, tag_id) VALUES (?, ?)`).run(id, tagId);
  db.prepare(
    `INSERT INTO translation_units (project_id, ordinal, source_hash, msgid, msgctxt, state)
     VALUES (?, 0, ?, ?, ?, 'untranslated')`,
  ).run(id, sourceHash(msgid, undefined), msgid, msgctxt);
}
