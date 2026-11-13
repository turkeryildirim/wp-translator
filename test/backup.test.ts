import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createDatabaseBackup, pruneBackups, listBackups } from '../src/db/backup.ts';

describe('database backup and pruning', () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wp-translator-backup-test-'));
    dbPath = join(tempDir, 'test.sqlite');
    db = new Database(dbPath);
    db.exec('CREATE TABLE test_data (id INTEGER PRIMARY KEY, name TEXT);');
    db.prepare('INSERT INTO test_data (name) VALUES (?)').run('sample entry');
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates an online sqlite backup in backups/ folder', async () => {
    const backupFile = await createDatabaseBackup(db, dbPath, 7);
    expect(existsSync(backupFile)).toBe(true);

    const backupDb = new Database(backupFile);
    const row = backupDb.prepare('SELECT name FROM test_data WHERE id = 1').get() as { name: string };
    expect(row.name).toBe('sample entry');
    backupDb.close();
  });

  it('prunes backups beyond maxBackups retention limit', () => {
    const backupDir = join(tempDir, 'backups');
    const mkFile = (name: string, delay: number) => {
      const p = join(backupDir, name);
      writeFileSync(p, 'dummy');
    };

    mkdirSync(backupDir, { recursive: true });

    // Create 10 dummy backup files
    for (let i = 1; i <= 10; i++) {
      mkFile(`wp-translator-2026-01-0${i < 10 ? '0' + i : i}_00-00-00.sqlite`, i);
    }

    expect(listBackups(backupDir).length).toBe(10);

    const pruned = pruneBackups(backupDir, 7);
    expect(pruned.length).toBe(3);
    expect(listBackups(backupDir).length).toBe(7);
  });
});

