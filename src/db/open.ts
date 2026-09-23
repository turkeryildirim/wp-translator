import Database from 'better-sqlite3';
import { latestVersion, migrations } from './migrations.ts';

export type Db = Database.Database;

/**
 * Open the database, creating it on first use and bringing it up to date.
 *
 * `better-sqlite3` is synchronous, which suits a single-user local tool: there
 * is no connection pool and no reason to wrap a local file in async plumbing.
 */
export function openDb(path: string): Db {
  const db = new Database(path);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const current = db.pragma('user_version', { simple: true }) as number;

  if (current > latestVersion) {
    throw new Error(
      `Database schema is version ${current}, newer than this build understands (${latestVersion}). ` +
        'Update wp-translator rather than opening it with this one.',
    );
  }

  for (const migration of migrations) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }

  return db;
}
