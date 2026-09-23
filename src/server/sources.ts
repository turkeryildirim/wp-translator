import type { Db } from '../db/open.ts';
import { syncTrustedSource } from '../glossary/sync.ts';
import { parsePo } from '../po/parse.ts';
import { fetchExport } from '../wporg/fetch.ts';
import { exportUrl, parseProjectUrl } from '../wporg/project.ts';

export interface TrustedSourceRow {
  id: number;
  translateUrl: string;
  projectPath: string;
  family: string;
  label: string | null;
  /** Lower wins when sources disagree (D36). Ties are the common case (R15). */
  rank: number;
  lastSyncedAt: string | null;
  entries: number;
  tagIds: number[];
}

export function listSources(db: Db): TrustedSourceRow[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.translate_url AS translateUrl, s.project_path AS projectPath,
              s.family, s.label, s.rank, s.last_synced_at AS lastSyncedAt,
              count(DISTINCT l.entry_id) AS entries
         FROM trusted_sources s
         LEFT JOIN glossary_entry_sources l ON l.trusted_source_id = s.id
        GROUP BY s.id
        ORDER BY s.rank, s.id`,
    )
    .all() as Omit<TrustedSourceRow, 'tagIds'>[];

  const tags = db.prepare(`SELECT trusted_source_id AS id, tag_id AS tagId FROM trusted_source_tags`)
    .all() as { id: number; tagId: number }[];

  const bySource = new Map<number, number[]>();
  for (const tag of tags) bySource.set(tag.id, [...(bySource.get(tag.id) ?? []), tag.tagId]);

  return rows.map((row) => ({ ...row, tagIds: bySource.get(row.id) ?? [] }));
}

export function addSource(db: Db, url: string, tagIds: readonly number[], label?: string): number {
  const ref = parseProjectUrl(url);

  return db.transaction((): number => {
    const nextRank =
      ((db.prepare(`SELECT max(rank) AS r FROM trusted_sources`).get() as { r: number | null }).r ??
        0) + 1;

    const id = Number(
      db
        .prepare(
          `INSERT INTO trusted_sources (translate_url, family, project_path, label, rank)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(url, ref.family, ref.projectPath, label ?? ref.projectPath, nextRank).lastInsertRowid,
    );

    const link = db.prepare(
      `INSERT INTO trusted_source_tags (trusted_source_id, tag_id) VALUES (?, ?)`,
    );
    for (const tagId of tagIds) link.run(id, tagId);

    return id;
  })();
}

export function removeSource(db: Db, id: number): void {
  // Cascades to the links; entries no source vouches for are then unreferenced,
  // so the same sweep the sync uses cleans them up.
  db.transaction(() => {
    db.prepare(`DELETE FROM trusted_sources WHERE id = ?`).run(id);
    db.prepare(
      `DELETE FROM glossary_entries
        WHERE origin = 'trusted' AND id NOT IN (SELECT entry_id FROM glossary_entry_sources)`,
    ).run();
  })();
}

/** Reorder by rank. The order is what actually decides most disagreements (R15). */
export function reorderSources(db: Db, ids: readonly number[]): void {
  const update = db.prepare(`UPDATE trusted_sources SET rank = ? WHERE id = ?`);
  db.transaction(() => {
    ids.forEach((id, index) => update.run(index + 1, id));
  })();
}

export interface SyncProgress {
  running: boolean;
  done: number;
  total: number;
  /** The source being fetched right now. */
  current: string | null;
  errors: { source: string; message: string }[];
  finishedAt: string | null;
}

const idle = (): SyncProgress => ({
  running: false,
  done: 0,
  total: 0,
  current: null,
  errors: [],
  finishedAt: null,
});

let progress: SyncProgress = idle();

export const syncProgress = (): SyncProgress => progress;

/**
 * Re-fetch every trusted source and re-import it.
 *
 * Runs unattended (D17) and in the background: 41 sources take over a minute
 * once paced, and the service rate-limits a tight loop (R24), so the panel polls
 * rather than waiting on one request.
 */
export function startSync(db: Db): SyncProgress {
  if (progress.running) return progress;

  const sources = listSources(db);
  progress = { ...idle(), running: true, total: sources.length };

  void (async () => {
    for (const source of sources) {
      progress.current = source.label ?? source.projectPath;
      try {
        const po = await fetchExport(exportUrl(source.projectPath));
        syncTrustedSource(db, source.id, parsePo(po), source.tagIds);
      } catch (error) {
        progress.errors.push({
          source: source.projectPath,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      progress.done += 1;
    }

    progress.running = false;
    progress.current = null;
    progress.finishedAt = new Date().toISOString();
  })();

  return progress;
}
