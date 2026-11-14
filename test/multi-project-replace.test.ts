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
});
