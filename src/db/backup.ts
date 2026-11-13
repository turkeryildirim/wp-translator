import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';

export interface BackupInfo {
  filename: string;
  path: string;
  sizeBytes: number;
  createdAt: Date;
}

/**
 * Creates an online SQLite backup file and prunes backups older than the latest `maxBackups`.
 * Returns the created backup file path.
 */
export async function createDatabaseBackup(
  db: Database.Database,
  dbPath: string,
  maxBackups = 7,
): Promise<string> {
  const backupDir = join(dirname(dbPath), 'backups');
  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const backupFile = join(backupDir, `wp-translator-${timestamp}.sqlite`);

  await db.backup(backupFile);
  pruneBackups(backupDir, maxBackups);

  return backupFile;
}

/**
 * Keeps only the most recent `maxBackups` SQLite backup files, removing older ones.
 */
export function pruneBackups(backupDir: string, maxBackups = 7): string[] {
  if (!existsSync(backupDir)) return [];

  const files = readdirSync(backupDir)
    .filter((f) => f.startsWith('wp-translator-') && f.endsWith('.sqlite'))
    .map((f) => {
      const fullPath = join(backupDir, f);
      return { path: fullPath, mtime: statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime); // newest first

  const deleted: string[] = [];
  if (files.length > maxBackups) {
    const toDelete = files.slice(maxBackups);
    for (const item of toDelete) {
      try {
        unlinkSync(item.path);
        deleted.push(item.path);
      } catch {}
    }
  }

  return deleted;
}

/**
 * Lists all existing backup files sorted by newest first.
 */
export function listBackups(backupDir: string): BackupInfo[] {
  if (!existsSync(backupDir)) return [];

  return readdirSync(backupDir)
    .filter((f) => f.startsWith('wp-translator-') && f.endsWith('.sqlite'))
    .map((f) => {
      const fullPath = join(backupDir, f);
      const st = statSync(fullPath);
      return {
        filename: f,
        path: fullPath,
        sizeBytes: st.size,
        createdAt: new Date(st.mtimeMs),
      };
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}
