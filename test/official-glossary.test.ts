import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { latestVersion } from '../src/db/migrations.ts';
import {
  importOfficialGlossary,
  parseGlossaryCsv,
  type GlossaryTerm,
} from '../src/glossary/officialGlossary.ts';

let db: Db;
let tagId: number;

const term = (en: string, tr: string, pos = 'noun', description = ''): GlossaryTerm => ({
  en,
  tr,
  pos,
  description,
});

const entries = () =>
  db
    .prepare(
      `SELECT source_text AS en, translation AS tr, pos, note, origin
         FROM glossary_entries ORDER BY source_text, pos`,
    )
    .all() as { en: string; tr: string; pos: string | null; note: string | null; origin: string }[];

beforeEach(() => {
  db = openDb(':memory:');
  tagId = Number(db.prepare(`INSERT INTO tags (name) VALUES ('wordpress')`).run().lastInsertRowid);
});

describe('CSV parsing', () => {
  it('reads the four columns GlotPress exports', () => {
    const csv = 'en,tr,pos,description\naccess,erişmek,verb,\naccordion,akordeon,noun,\n';

    expect(parseGlossaryCsv(csv)).toEqual([
      { en: 'access', tr: 'erişmek', pos: 'verb', description: '' },
      { en: 'accordion', tr: 'akordeon', pos: 'noun', description: '' },
    ]);
  });

  it('handles quoted fields and embedded commas', () => {
    const csv = 'en,tr,pos,description\n"accent color","vurgu rengi",noun,"Renk paletleri, örnek"\n';

    expect(parseGlossaryCsv(csv)[0]).toEqual({
      en: 'accent color',
      tr: 'vurgu rengi',
      pos: 'noun',
      description: 'Renk paletleri, örnek',
    });
  });

  it('handles newlines inside a quoted description', () => {
    // The real export has these: descriptions carry a URL on a second line.
    const csv = 'en,tr,pos,description\naccount,hesap,noun,"İlk satır\nİkinci satır"\n';

    expect(parseGlossaryCsv(csv)[0]!.description).toBe('İlk satır\nİkinci satır');
  });

  it('handles an escaped quote', () => {
    const csv = 'en,tr,pos,description\nquote,alıntı,noun,"He said ""hello"""\n';

    expect(parseGlossaryCsv(csv)[0]!.description).toBe('He said "hello"');
  });

  it('refuses a CSV that is not the glossary', () => {
    expect(() => parseGlossaryCsv('a,b\n1,2\n')).toThrow(/Unexpected glossary CSV header/);
  });
});

describe('official glossary import', () => {
  it('stores terms as owner entries so a sweep never removes them', () => {
    importOfficialGlossary(db, [term('page', 'sayfa')], tagId);

    expect(entries()).toEqual([
      { en: 'page', tr: 'sayfa', pos: 'noun', note: null, origin: 'owner' },
    ]);
  });

  it('keeps noun and verb readings of one term as separate rows', () => {
    const result = importOfficialGlossary(
      db,
      [term('archive', 'arşiv', 'noun'), term('archive', 'arşivle', 'verb')],
      tagId,
    );

    expect(result.added).toBe(2);
    expect(entries().map((e) => [e.pos, e.tr])).toEqual([
      ['noun', 'arşiv'],
      ['verb', 'arşivle'],
    ]);
  });

  it('carries the description through as a note', () => {
    importOfficialGlossary(db, [term('account recovery', 'hesap kurtarma', 'noun', 'Parola için')], tagId);

    expect(entries()[0]!.note).toBe('Parola için');
  });

  it('is idempotent', () => {
    const terms = [term('page', 'sayfa'), term('post', 'yazı')];
    importOfficialGlossary(db, terms, tagId);
    const second = importOfficialGlossary(db, terms, tagId);

    expect(second).toMatchObject({ added: 0, kept: 2, removed: 0, skipped: 0 });
    expect(entries()).toHaveLength(2);
  });

  it('replaces a reading the glossary dropped upstream', () => {
    // The translation is part of the key, so a changed reading is a new row and
    // the old one has to go — otherwise a correction upstream would leave both
    // here for ever. The real glossary does carry genuine alternatives
    // (`editor` is both `editör` and `düzenleyici`), which is why they are rows
    // rather than an update in place.
    importOfficialGlossary(db, [term('editor', 'editör')], tagId);
    const result = importOfficialGlossary(db, [term('editor', 'düzenleyici')], tagId);

    expect(result).toMatchObject({ added: 1, removed: 1 });
    expect(entries().map((e) => e.tr)).toEqual(['düzenleyici']);
  });

  it('keeps genuine alternatives the glossary offers under one part of speech', () => {
    const result = importOfficialGlossary(
      db,
      [term('author', 'yazar'), term('author', 'geliştirici')],
      tagId,
    );

    expect(result).toMatchObject({ added: 2, removed: 0 });
    expect(entries().map((e) => e.tr).sort()).toEqual(['geliştirici', 'yazar']);
  });

  it('skips rows with an empty side', () => {
    const result = importOfficialGlossary(db, [term('page', ''), term('', 'sayfa')], tagId);

    expect(result.skipped).toBe(2);
    expect(entries()).toHaveLength(0);
  });
});

describe('migrations', () => {
  it('brings a fresh database to the latest version', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(latestVersion);
  });

  it('is idempotent when reopening an up-to-date database', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'wpt-')), 'db.sqlite');
    openDb(path).close();
    const reopened = openDb(path);

    expect(reopened.pragma('user_version', { simple: true })).toBe(latestVersion);
    expect(
      (reopened.prepare(`SELECT count(*) AS n FROM glossary_entries`).get() as { n: number }).n,
    ).toBe(0);
    reopened.close();
  });

  it('refuses a database written by a newer build', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'wpt-')), 'db.sqlite');
    const created = openDb(path);
    created.pragma(`user_version = ${latestVersion + 1}`);
    created.close();

    expect(() => openDb(path)).toThrow(/newer than this build understands/);
  });
});
