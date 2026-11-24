import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/open.ts';
import { clearSystemLogs, listSystemLogs, logMessage } from '../src/db/logs.ts';

describe('system_logs database operations', () => {
  it('writes, filters by category and search term, and clears logs', () => {
    const db = openDb(':memory:');

    logMessage(db, {
      level: 'error',
      category: 'crawler',
      message: 'Failed to crawl project',
      details: { slug: 'woocommerce', error: 'Timeout' },
    });
    logMessage(db, {
      level: 'info',
      category: 'queue',
      message: 'Queue review completed',
      details: 'Done',
    });

    // Filter by level
    const errors = listSystemLogs(db, { level: 'error' });
    expect(errors.total).toBe(1);
    expect(errors.entries[0]!.category).toBe('crawler');

    // Filter by category
    const queue = listSystemLogs(db, { category: 'queue' });
    expect(queue.total).toBe(1);

    // Filter by search query
    const searchMatch = listSystemLogs(db, { search: 'woocommerce' });
    expect(searchMatch.total).toBe(1);

    // Clear logs
    const cleared = clearSystemLogs(db);
    expect(cleared).toBeGreaterThan(0);
    expect(listSystemLogs(db).total).toBe(0);
  });
});
