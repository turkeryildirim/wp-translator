import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/open.ts';
import type { Db } from '../src/db/open.ts';
import {
  remember,
  listMemoryEntries,
  deleteMemoryEntry,
  deleteMemoryEntries,
  clearMemory,
  memoryCounts,
} from '../src/ai/memory.ts';
import { logMessage, listSystemLogs, clearSystemLogs } from '../src/db/logs.ts';

describe('ai memory and system logs', () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wp-translator-mem-logs-'));
    db = openDb(join(tempDir, 'test.sqlite'));
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('manages ai memory entries and bulk deletion', () => {
    remember(db, {
      kind: 'translation',
      keyHash: 'hash1',
      rulesHash: 'rules1',
      sourceText: 'Hello world',
      question: { source: 'Hello world' },
      answer: { translation: 'Merhaba dünya' },
      model: 'test-model',
    });

    remember(db, {
      kind: 'judgement',
      keyHash: 'hash2',
      rulesHash: 'rules1',
      sourceText: 'Cancel',
      question: { source: 'Cancel' },
      answer: { verdict: 'exact', reason: 'Accurate' },
      model: 'test-model',
    });

    const list = listMemoryEntries(db);
    expect(list.total).toBe(2);
    expect(list.entries[0]?.sourceText).toBe('Cancel');
    expect(list.entries[1]?.sourceText).toBe('Hello world');

    const counts = memoryCounts(db);
    expect(counts.translation).toBe(1);
    expect(counts.judgement).toBe(1);

    // Search filter
    const searchRes = listMemoryEntries(db, { search: 'Merhaba' });
    expect(searchRes.total).toBe(1);
    expect(searchRes.entries[0]?.sourceText).toBe('Hello world');

    // Delete single
    const deleted = deleteMemoryEntry(db, list.entries[0]!.id);
    expect(deleted).toBe(true);
    expect(listMemoryEntries(db).total).toBe(1);

    // Clear
    clearMemory(db);
    expect(listMemoryEntries(db).total).toBe(0);
  });

  it('manages system logs and enforces retention', () => {
    logMessage(db, {
      level: 'error',
      category: 'glotpress',
      message: 'Template mismatch test error',
      details: { url: 'https://translate.wordpress.org' },
    });

    logMessage(db, {
      level: 'info',
      category: 'system',
      message: 'System started',
    });

    const allLogs = listSystemLogs(db);
    expect(allLogs.total).toBe(2);
    expect(allLogs.entries[0]?.category).toBe('system');
    expect(allLogs.entries[1]?.category).toBe('glotpress');

    const errLogs = listSystemLogs(db, { level: 'error' });
    expect(errLogs.total).toBe(1);
    expect(errLogs.entries[0]?.message).toBe('Template mismatch test error');

    clearSystemLogs(db);
    expect(listSystemLogs(db).total).toBe(0);
  });
});
