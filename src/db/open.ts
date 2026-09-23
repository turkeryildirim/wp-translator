import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Db = Database.Database;

/** Bumped whenever `schema.sql` changes in a way an existing database must follow. */
const SCHEMA_VERSION = 1;

const schemaSql = (): string =>
  readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf-8');

/**
 * Open the database, creating it on first use.
 *
 * `better-sqlite3` is synchronous, which suits a single-user local tool: there
 * is no connection pool and no reason to wrap a local file in async plumbing.
 */
export function openDb(path: string): Db {
  const db = new Database(path);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const version = db.pragma('user_version', { simple: true }) as number;
  if (version === 0) {
    db.exec(schemaSql());
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    return db;
  }

  if (version > SCHEMA_VERSION) {
    throw new Error(
      `Database schema is version ${version}, newer than this build understands (${SCHEMA_VERSION}).`,
    );
  }

  return db;
}
