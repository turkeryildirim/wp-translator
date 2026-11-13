import type { Db } from './open.ts';

export function getAppSetting(db: Db, key: string): string | null {
  const row = db
    .prepare(`SELECT value FROM app_settings WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setAppSetting(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_settings (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value.trim());
}
