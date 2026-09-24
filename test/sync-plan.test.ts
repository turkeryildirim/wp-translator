import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/open.ts';
import { prepare } from '../src/glossary/sync.ts';

/** EXPLAIN still needs every named parameter bound; the values are ignored. */
const paramsFor = (sql: string): Record<string, unknown> =>
  Object.fromEntries([...sql.matchAll(/@(\w+)/g)].map((match) => [match[1]!, '']));

const planOf = (db: ReturnType<typeof openDb>, sql: string): string =>
  (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(paramsFor(sql)) as { detail: string }[])
    .map((row) => row.detail)
    .join(' | ');

describe('the statements run for every string of every source', () => {
  // These two run once per unit per tag — 58 000 times in a full update. Written
  // with `OR` instead of two seeks, they stopped matching
  // idx_glossary_memory_key and fell back to idx_glossary_tag, which is every
  // row in the glossary because almost all of them carry one tag. Measured at
  // 6.777 ms against 0.007 ms per lookup, and better-sqlite3 is synchronous, so
  // the server stopped answering rather than merely running slowly.
  it.each(['linkSource', 'recordContext'] as const)(
    'looks %s up by index, never by scan',
    (name) => {
      const db = openDb(':memory:');
      const plan = planOf(db, prepare(db)[name].source);

      expect(plan).toContain('idx_glossary_memory_key');
      expect(plan).not.toContain('idx_glossary_tag');
      expect(plan).not.toMatch(/SCAN glossary_entries/);
    },
  );
});
