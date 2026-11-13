import type { Db } from './open.ts';

export type LogLevel = 'error' | 'warn' | 'info';

export interface SystemLogEntry {
  id: number;
  level: LogLevel;
  category: string;
  message: string;
  details: string | null;
  createdAt: string;
}

export interface LogFilter {
  level?: LogLevel | undefined;
  category?: string | undefined;
  search?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/**
 * Inserts a system log and automatically cleans up logs older than 7 days.
 */
export function logMessage(
  db: Db,
  entry: {
    level: LogLevel;
    category: string;
    message: string;
    details?: unknown;
  },
): void {
  try {
    const detailsStr = entry.details
      ? typeof entry.details === 'string'
        ? entry.details
        : JSON.stringify(entry.details, null, 2)
      : null;

    db.prepare(`
      INSERT INTO system_logs (level, category, message, details)
      VALUES (?, ?, ?, ?)
    `).run(entry.level, entry.category, entry.message, detailsStr);

    // Enforce 7-day retention policy
    db.prepare(`
      DELETE FROM system_logs
       WHERE created_at < datetime('now', '-7 days')
    `).run();
  } catch (err) {
    console.error('Failed to write system log:', err);
  }
}

/**
 * Retrieves paginated system logs matching the filter.
 */
export function listSystemLogs(
  db: Db,
  filter?: LogFilter,
): { total: number; entries: SystemLogEntry[] } {
  const whereClauses: string[] = [];
  const params: unknown[] = [];

  if (filter?.level) {
    whereClauses.push('level = ?');
    params.push(filter.level);
  }

  if (filter?.category) {
    whereClauses.push('category = ?');
    params.push(filter.category);
  }

  if (filter?.search?.trim()) {
    whereClauses.push('(message LIKE ? OR details LIKE ?)');
    params.push(`%${filter.search.trim()}%`, `%${filter.search.trim()}%`);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const totalRow = db.prepare(`SELECT count(*) AS cnt FROM system_logs ${whereSql}`).get(...params) as { cnt: number };
  const total = totalRow?.cnt ?? 0;

  const limit = filter?.limit ?? 100;
  const offset = filter?.offset ?? 0;

  const entries = db.prepare(`
    SELECT id, level, category, message, details, created_at AS createdAt
      FROM system_logs
     ${whereSql}
     ORDER BY id DESC
     LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as SystemLogEntry[];

  return { total, entries };
}

/**
 * Clears all system logs.
 */
export function clearSystemLogs(db: Db): number {
  const info = db.prepare('DELETE FROM system_logs').run();
  return info.changes;
}
