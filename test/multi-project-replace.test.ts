import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/open.ts';
import type { Db } from '../src/db/open.ts';
import {
  searchMultiProjectUnits,
  executeMultiProjectReplace,
  turkishRegex,
} from '../src/server/multiReplace.ts';

describe('multi-project find and replace', () => {
  let tempDir: string;
  let db: Db;
  let p1: number;
  let p2: number;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wp-translator-multi-replace-'));
    db = openDb(join(tempDir, 'test.sqlite'));

    // Insert 2 dummy projects
    const insProject = db.prepare(`
      INSERT INTO projects (family, project_path, translate_url, slug, name)
      VALUES (?, ?, ?, ?, ?)
    `);
    p1 = Number(
      insProject.run(
        'plugin',
        'wp-plugins/woocommerce',
        'https://translate.wordpress.org/locale/tr/default/wp-plugins/woocommerce/',
        'woocommerce',
        'WooCommerce',
      ).lastInsertRowid,
    );
    p2 = Number(
      insProject.run(
        'plugin',
        'wp-plugins/elementor',
        'https://translate.wordpress.org/locale/tr/default/wp-plugins/elementor/',
        'elementor',
        'Elementor',
      ).lastInsertRowid,
    );

    // Insert sample translation units
    const insUnit = db.prepare(`
      INSERT INTO translation_units (project_id, ordinal, source_hash, msgid, msgstr, state)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    // p1: 1. Edit post -> Girdiyi düzenle
    insUnit.run(p1, 1, 'h1', 'Edit post', 'Girdiyi düzenle', 'ok');
    // p1: 2. Input value -> Girdi değeri (should NOT be touched if sourceText="post")
    insUnit.run(p1, 2, 'h2', 'Input value', 'Girdi değeri', 'ok');
    // p2: 3. View post -> Girdiyi görüntüle
    insUnit.run(p2, 1, 'h3', 'View post', 'Girdiyi görüntüle', 'ok');
    // p2: 4. Çıkış yap -> Çıkış Yap (Turkish uppercase/lowercase test)
    insUnit.run(p2, 2, 'h4', 'Log out', 'ÇIKIŞ YAP', 'ok');
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('filters by sourceText so unrelated translations are preserved', () => {
    // Search for "Girdiyi" with sourceText "post"
    const result = searchMultiProjectUnits(db, {
      sourceText: 'post',
      findText: 'Girdiyi',
      replaceText: 'Yazıyı',
      caseSensitive: false,
    });

    expect(result.total).toBe(2);
    expect(result.projectCount).toBe(2);
    // Elementor comes before WooCommerce alphabetically by p.name
    expect(result.matches[0]?.projectName).toBe('Elementor');
    expect(result.matches[0]?.msgid).toBe('View post');
    expect(result.matches[0]?.proposedMsgstr).toBe('Yazıyı görüntüle');
    expect(result.matches[1]?.projectName).toBe('WooCommerce');
    expect(result.matches[1]?.msgid).toBe('Edit post');
    expect(result.matches[1]?.proposedMsgstr).toBe('Yazıyı düzenle');
  });

  it('respects case-sensitivity accurately including Turkish letters', () => {
    // Exact case sensitive search
    const sensitiveRes = searchMultiProjectUnits(db, {
      findText: 'Girdiyi',
      replaceText: 'Yazıyı',
      caseSensitive: true,
    });
    expect(sensitiveRes.total).toBe(2);

    // Case sensitive with non-matching case
    const sensitiveMismatch = searchMultiProjectUnits(db, {
      findText: 'girdiyi',
      replaceText: 'yazıyı',
      caseSensitive: true,
    });
    expect(sensitiveMismatch.total).toBe(0);

    // Case insensitive matching with Turkish letters (çıkış vs ÇIKIŞ)
    const turkishCaseRes = searchMultiProjectUnits(db, {
      findText: 'çıkış yap',
      replaceText: 'oturumu kapat',
      caseSensitive: false,
    });
    expect(turkishCaseRes.total).toBe(1);
    expect(turkishCaseRes.matches[0]?.msgid).toBe('Log out');
  });

  it('executes bulk replacement for selected units only', () => {
    const searchRes = searchMultiProjectUnits(db, {
      findText: 'Girdiyi',
      replaceText: 'Yazıyı',
      caseSensitive: false,
    });
    expect(searchRes.total).toBe(2);

    // Replace only the first unit (Elementor - View post)
    const unitToReplace = searchRes.matches[0]!;
    const execRes = executeMultiProjectReplace(db, {
      unitIds: [unitToReplace.id],
      findText: 'Girdiyi',
      replaceText: 'Yazıyı',
      caseSensitive: false,
    });

    expect(execRes.changed).toBe(1);
    expect(execRes.projectCount).toBe(1);

    // Verify unit updated to state 'review' and provenance 'human'
    const row = db
      .prepare('SELECT msgstr, state, provenance FROM translation_units WHERE id = ?')
      .get(unitToReplace.id) as { msgstr: string; state: string; provenance: string };
    expect(row.msgstr).toBe('Yazıyı görüntüle');
    expect(row.state).toBe('review');
    expect(row.provenance).toBe('human');

    // Verify other unit was untouched
    const other = db
      .prepare('SELECT msgstr FROM translation_units WHERE id = ?')
      .get(searchRes.matches[1]!.id) as { msgstr: string };
    expect(other.msgstr).toBe(searchRes.matches[1]!.msgstr);
  });

  it('executes bulk replacement across all matching units across projects', () => {
    const execRes = executeMultiProjectReplace(db, {
      sourceText: 'post',
      findText: 'Girdiyi',
      replaceText: 'Yazıyı',
      caseSensitive: true,
    });

    expect(execRes.changed).toBe(2);
    expect(execRes.projectCount).toBe(2);

    // Input value should NOT have been touched
    const inputVal = db
      .prepare("SELECT msgstr FROM translation_units WHERE msgid = 'Input value'")
      .get() as { msgstr: string };
    expect(inputVal.msgstr).toBe('Girdi değeri');
  });

  it('handles plural forms correctly (e.g. %d message/%d messages -> %d mesaj/%d mesaj)', () => {
    // Insert plural unit with typo in plural form
    db.prepare(`
      INSERT INTO translation_units (project_id, ordinal, source_hash, msgid, msgid_plural, msgstr, msgstr_plural, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(p1, 5, 'h_plural', '%d message', '%d messages', '%d mesaj', '%d mesjalar', 'ok');

    // 1. Search for "mesjalar" to replace with "mesaj"
    const searchRes = searchMultiProjectUnits(db, {
      sourceText: 'message',
      findText: 'mesjalar',
      replaceText: 'mesaj',
      caseSensitive: true,
    });

    expect(searchRes.total).toBe(1);
    expect(searchRes.matches[0]?.msgid).toBe('%d message');
    expect(searchRes.matches[0]?.msgidPlural).toBe('%d messages');
    expect(searchRes.matches[0]?.msgstr).toBe('%d mesaj');
    expect(searchRes.matches[0]?.msgstrPlural).toBe('%d mesjalar');
    expect(searchRes.matches[0]?.proposedMsgstr).toBe('%d mesaj');
    expect(searchRes.matches[0]?.proposedMsgstrPlural).toBe('%d mesaj');

    // 2. Execute replacement
    const execRes = executeMultiProjectReplace(db, {
      sourceText: 'message',
      findText: 'mesjalar',
      replaceText: 'mesaj',
      caseSensitive: true,
    });

    expect(execRes.changed).toBe(1);
    expect(execRes.blocked).toBe(0);

    // Verify row in database: singular and plural both now '%d mesaj'
    const updated = db
      .prepare('SELECT msgstr, msgstr_plural AS msgstrPlural, state, blocked FROM translation_units WHERE msgid = ?')
      .get('%d message') as { msgstr: string; msgstrPlural: string; state: string; blocked: number };
    expect(updated.msgstr).toBe('%d mesaj');
    expect(updated.msgstrPlural).toBe('%d mesaj');
    expect(updated.state).toBe('review');
    expect(updated.blocked).toBe(0);
  });

  it('restricts search and replacement by targetScope (plural only vs singular only)', () => {
    // Insert a unit where both singular and plural contain the word "kayıt"
    db.prepare(`
      INSERT INTO translation_units (project_id, ordinal, source_hash, msgid, msgid_plural, msgstr, msgstr_plural, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(p2, 10, 'h_scope', '%d record', '%d records', '%d kayıt', '%d kayıtlar', 'ok');

    // When targeting only plural:
    const pluralOnly = searchMultiProjectUnits(db, {
      findText: 'kayıtlar',
      replaceText: 'öğeler',
      targetScope: 'plural',
      caseSensitive: true,
    });

    const matchedUnit = pluralOnly.matches.find((m) => m.msgid === '%d record');
    expect(matchedUnit).toBeDefined();
    // Singular should remain untouched in proposal
    expect(matchedUnit?.proposedMsgstr).toBe('%d kayıt');
    // Plural should be updated
    expect(matchedUnit?.proposedMsgstrPlural).toBe('%d öğeler');

    // Execute with targetScope: 'plural'
    executeMultiProjectReplace(db, {
      unitIds: [matchedUnit!.id],
      findText: 'kayıtlar',
      replaceText: 'öğeler',
      targetScope: 'plural',
      caseSensitive: true,
    });

    const row = db
      .prepare('SELECT msgstr, msgstr_plural AS msgstrPlural FROM translation_units WHERE id = ?')
      .get(matchedUnit!.id) as { msgstr: string; msgstrPlural: string };
    expect(row.msgstr).toBe('%d kayıt'); // Untouched!
    expect(row.msgstrPlural).toBe('%d öğeler'); // Replaced!
  });

  it('handles empty findText edge case in search and execute', () => {
    const emptySearch = searchMultiProjectUnits(db, {
      findText: '',
      replaceText: 'test',
    });
    expect(emptySearch).toEqual({ total: 0, projectCount: 0, matches: [] });

    expect(() =>
      executeMultiProjectReplace(db, {
        findText: '',
        replaceText: 'test',
      }),
    ).toThrow('Aranacak metin boş olamaz');
  });
});
