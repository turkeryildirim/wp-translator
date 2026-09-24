import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { exportProject } from '../src/project/export.ts';
import { importProject } from '../src/project/import.ts';
import { parsePo } from '../src/po/parse.ts';
import type { Catalogue, TranslationUnit } from '../src/po/types.ts';

const catalogue = (units: Partial<TranslationUnit>[]): Catalogue => ({
  headers: {
    'MIME-Version': '1.0',
    'Content-Type': 'text/plain; charset=UTF-8',
    'Plural-Forms': 'nplurals=2; plural=n > 1;',
    Language: 'tr',
  },
  units: units.map((u, ordinal) => ({ ordinal, msgid: '', ...u }) as TranslationUnit),
});

let db: Db;

const settle = (msgid: string, msgstr: string, plural?: string) =>
  db
    .prepare(
      `UPDATE translation_units
          SET state = 'ok', provenance = 'human', msgstr = ?, msgstr_plural = ?
        WHERE msgid = ?`,
    )
    .run(msgstr, plural ?? null, msgid);

const exported = (projectId: number) => {
  const result = exportProject(db, projectId);
  return { ...result, parsed: parsePo(result.po) };
};

beforeEach(() => {
  db = openDb(':memory:');
});

describe('PO export', () => {
  it('writes only settled units and says how many it withheld', () => {
    const id = importProject(
      db,
      { family: 'plugin', projectPath: 'p', translateUrl: 't' },
      catalogue([{ msgid: 'Save' }, { msgid: 'Cancel' }, { msgid: 'Delete' }]),
    );
    settle('Save', 'Kaydet');

    const { exported: count, withheld, parsed } = exported(id);

    expect({ count, withheld }).toEqual({ count: 1, withheld: 2 });
    expect(parsed.units.map((u) => u.msgid)).toEqual(['Save']);
  });

  it('carries msgctxt through untouched', () => {
    // GlotPress matches by singular + plural + context; an entry that loses its
    // context matches no original and the translation is dropped on import.
    const id = importProject(
      db,
      { family: 'plugin', projectPath: 'p', translateUrl: 't' },
      catalogue([{ msgid: 'May', msgctxt: 'May abbreviation' }]),
    );
    settle('May', 'May');

    expect(exported(id).parsed.units[0]).toMatchObject({
      msgid: 'May',
      msgctxt: 'May abbreviation',
      msgstr: 'May',
    });
  });

  it('keeps references, extractor comments and plural forms', () => {
    const id = importProject(
      db,
      { family: 'plugin', projectPath: 'p', translateUrl: 't' },
      catalogue([
        {
          msgid: '%s item',
          msgidPlural: '%s items',
          refs: 'templates/cart.php:31',
          extractedComments: 'translators: %s is a count',
        },
      ]),
    );
    settle('%s item', '%s öge', '%s öge');

    expect(exported(id).parsed.units[0]).toMatchObject({
      msgidPlural: '%s items',
      refs: 'templates/cart.php:31',
      extractedComments: 'translators: %s is a count',
      msgstr: '%s öge',
      msgstrPlural: '%s öge',
    });
  });

  it('preserves the Plural-Forms header', () => {
    const id = importProject(
      db,
      { family: 'plugin', projectPath: 'p', translateUrl: 't' },
      catalogue([{ msgid: 'Save' }]),
    );
    settle('Save', 'Kaydet');

    expect(exported(id).parsed.headers['Plural-Forms']).toBe('nplurals=2; plural=n > 1;');
  });

  it('emits nothing GlotPress would drop or reinterpret', () => {
    const id = importProject(
      db,
      { family: 'plugin', projectPath: 'p', translateUrl: 't' },
      catalogue([{ msgid: 'Save' }, { msgid: 'Unsettled' }]),
    );
    settle('Save', 'Kaydet');

    const text = exportProject(db, id).po.toString('utf-8');

    expect(text).not.toMatch(/^#, .*fuzzy/m);
    expect(text).not.toMatch(/^#~/m);
    expect(text).not.toContain('Unsettled');
    // The header entry legitimately has an empty msgstr, so check the entries.
    expect(parsePo(text).units.every((u) => u.msgstr)).toBe(true);
  });

  it('withholds a unit marked ok but left blank', () => {
    // Belt and braces: an empty msgstr would be skipped by GlotPress anyway, so
    // sending it looks like success while achieving nothing.
    const id = importProject(
      db,
      { family: 'plugin', projectPath: 'p', translateUrl: 't' },
      catalogue([{ msgid: 'Save' }]),
    );
    db.prepare(`UPDATE translation_units SET state = 'ok', msgstr = '' WHERE msgid = 'Save'`).run();

    expect(exportProject(db, id)).toMatchObject({ exported: 0, withheld: 1 });
  });

  it('produces an empty but valid catalogue when nothing is settled', () => {
    const id = importProject(
      db,
      { family: 'plugin', projectPath: 'p', translateUrl: 't' },
      catalogue([{ msgid: 'Save' }]),
    );

    const { exported: count, parsed } = exported(id);

    expect(count).toBe(0);
    expect(parsed.units).toHaveLength(0);
    expect(parsed.headers['Language']).toBe('tr');
  });

  it('refuses an unknown project', () => {
    expect(() => exportProject(db, 999)).toThrow(/No project with id 999/);
  });
});
