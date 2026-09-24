import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/open.ts';
import { listSources, reorderSources } from '../src/server/sources.ts';
import { listStyleRules, styleGuideFor } from '../src/server/tags.ts';

/**
 * A fresh database has to be usable without the owner pasting 41 URLs and a
 * style guide in by hand. These assert the seed, not the schema.
 */
describe('a fresh database', () => {
  it('comes with the owner’s trusted sources', () => {
    const db = openDb(':memory:');
    const sources = listSources(db);

    expect(sources).toHaveLength(41);
    expect(sources.map((source) => source.projectPath)).toContain('wp/dev');
    expect(sources.map((source) => source.projectPath)).toContain('wp-plugins/woocommerce/dev');
    expect(sources.map((source) => source.projectPath)).toContain('apps/ios/dev');
    expect(sources.map((source) => source.projectPath)).toContain('meta/learn-wordpress');
  });

  it('ranks core first, since rank decides most disagreements', () => {
    const db = openDb(':memory:');
    expect(listSources(db)[0]!.projectPath).toBe('wp/dev');
  });

  it('gives every source a tag, so a sync has somewhere to put its entries', () => {
    const db = openDb(':memory:');
    expect(listSources(db).every((source) => source.tagIds.length > 0)).toBe(true);
  });

  it('knows every family the list covers', () => {
    const db = openDb(':memory:');
    const families = new Set(listSources(db).map((source) => source.family));

    expect(families).toEqual(new Set(['core', 'plugin', 'theme', 'apps', 'meta']));
  });

  it('comes with the Turkish style guide', () => {
    const db = openDb(':memory:');
    const rules = listStyleRules(db);

    expect(rules).toHaveLength(1);
    expect(rules[0]!.tagId).toBeNull();
    // The rule that costs the most if missed: sentence case, not title case.
    expect(rules[0]!.body).toContain('Tüm değişiklikleri kaydet');
    expect(rules[0]!.body).toContain('yer tutucuya ek ekleme');
  });

  it('hands that guide to a project’s translation requests', () => {
    const db = openDb(':memory:');
    const projectId = Number(
      db
        .prepare(`INSERT INTO projects (family, project_path, translate_url) VALUES ('core','p','t')`)
        .run().lastInsertRowid,
    );

    expect(styleGuideFor(db, projectId)).toContain('Türkçe çeviri rehberi');
  });

  it('has no glossary yet, because that needs a fetch', () => {
    // Sources and the guide are data; the glossary is downloaded on first Update.
    const db = openDb(':memory:');
    expect(
      (db.prepare(`SELECT count(*) AS n FROM glossary_entries`).get() as { n: number }).n,
    ).toBe(0);
  });
});

describe('reordering sources', () => {
  it('moves a row to a new position without losing or duplicating any', () => {
    // Drag semantics: remove and insert, not swap with a neighbour.
    const db = openDb(':memory:');
    const before = listSources(db);

    const next = [...before];
    const [moved] = next.splice(next.length - 1, 1);
    next.splice(0, 0, moved!);
    reorderSources(db, next.map((source) => source.id));

    const after = listSources(db);
    expect(after[0]!.projectPath).toBe(before.at(-1)!.projectPath);
    expect(after[1]!.projectPath).toBe(before[0]!.projectPath);
    expect(after).toHaveLength(before.length);
    expect(new Set(after.map((source) => source.id)).size).toBe(before.length);
  });

  it('leaves rank a dense 1..n so the order is unambiguous', () => {
    const db = openDb(':memory:');
    const ids = listSources(db).map((source) => source.id).reverse();
    reorderSources(db, ids);

    expect(listSources(db).map((source) => source.rank)).toEqual(
      ids.map((_, index) => index + 1),
    );
  });
});
