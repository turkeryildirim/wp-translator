import { beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { searchGlossary } from '../src/server/glossary.ts';
import { sourceHash } from '../src/glossary/key.ts';

const ROWS = 20_000;
/**
 * Generous on purpose: the failure it guards against is quadratic, not gradual.
 * Two things have to hold, and measured at this size neither alone is a
 * disaster while both together are (R30):
 *
 * |                              | with idx_glossary_source | without |
 * |------------------------------|-------------------------:|--------:|
 * | page chosen, then decorated  |                    10 ms |  251 ms |
 * | one statement                |                    44 ms | 45.9 s  |
 *
 * So this budget cannot tell which of the two was lost — but it catches losing
 * both, which is what happened, and a page of the owner's real glossary took
 * 40 s. Anything near the budget means the shape changed, not that the machine
 * is busy.
 */
const BUDGET_MS = 1000;

let db: Db;

beforeAll(() => {
  db = openDb(':memory:');
  const tagId = Number(
    db.prepare(`INSERT INTO tags (name) VALUES ('bulk')`).run().lastInsertRowid,
  );
  const insert = db.prepare(
    `INSERT INTO glossary_entries
       (source_hash, source_text, msgctxt, tag_id, translation, origin)
     VALUES (?, ?, NULL, ?, ?, 'trusted')`,
  );
  // Two readings each, so the sibling count has something to find every time.
  db.transaction(() => {
    for (let i = 0; i < ROWS / 2; i += 1) {
      const source = `string number ${i}`;
      insert.run(sourceHash(source, undefined), source, tagId, `çeviri ${i}`);
      insert.run(sourceHash(source, undefined), source, tagId, `alternatif ${i}`);
    }
  })();
});

describe('paging through a large glossary', () => {
  it('costs the same deep in the list as at the front', () => {
    const first = timed(() => searchGlossary(db, { limit: 100, offset: 0 }));
    const deep = timed(() => searchGlossary(db, { limit: 100, offset: ROWS - 200 }));

    expect(first.rows).toHaveLength(100);
    expect(deep.rows).toHaveLength(100);
    expect(deep.ms).toBeLessThan(BUDGET_MS);
    expect(first.ms).toBeLessThan(BUDGET_MS);
  });

  it('counts a string’s other readings without scanning the tag', () => {
    const page = searchGlossary(db, { limit: 1, offset: 0 });
    expect(page.rows[0]!.readings).toBe(2);
    expect(page.total).toBe(ROWS);
  });

  it('stays quick with a substring search too', () => {
    const { rows, ms } = timed(() => searchGlossary(db, { search: 'number 1', limit: 100 }));

    expect(rows.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});

function timed<T extends { rows: unknown[] }>(run: () => T): T & { ms: number } {
  const started = Date.now();
  const result = run();
  return { ...result, ms: Date.now() - started };
}
