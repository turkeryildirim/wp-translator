import type { Db } from '../db/open.ts';
import {
  importOfficialGlossary,
  OFFICIAL_GLOSSARY_CSV,
  parseGlossaryCsv,
} from '../glossary/officialGlossary.ts';
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

/** Where the official glossary's terms land. The seeded tag, or the first one. */
function defaultTagId(db: Db): number {
  const row = db
    .prepare(`SELECT id FROM tags ORDER BY name = 'wordpress' DESC, id LIMIT 1`)
    .get() as { id: number } | undefined;
  if (row) return row.id;

  return Number(db.prepare(`INSERT INTO tags (name) VALUES ('wordpress')`).run().lastInsertRowid);
}

/** Replace a source's tags. The seeded list puts everything under one tag; this is how it is split. */
export function setSourceTags(db: Db, id: number, tagIds: readonly number[]): void {
  const add = db.prepare(
    `INSERT OR IGNORE INTO trusted_source_tags (trusted_source_id, tag_id) VALUES (?, ?)`,
  );
  db.transaction(() => {
    db.prepare(`DELETE FROM trusted_source_tags WHERE trusted_source_id = ?`).run(id);
    for (const tagId of tagIds) add.run(id, tagId);
  })();
}

/** Accepts a pasted URL with or without the scheme, and with or without a trailing slash. */
const PROJECT_URL = /^(?:https:\/\/)?translate\.wordpress\.org\/projects\/(.+)$/;

export function normaliseProjectUrl(input: string): string {
  const trimmed = input.trim();
  const match = PROJECT_URL.exec(trimmed);
  if (!match) {
    throw new Error(
      'Bu bir translate.wordpress.org proje adresi değil. Beklenen biçim: ' +
        'https://translate.wordpress.org/projects/<proje>/tr/default/',
    );
  }

  const path = match[1]!.replace(/\/+$/, '');
  return `https://translate.wordpress.org/projects/${path}/`;
}

/**
 * Check the project actually exports before storing it.
 *
 * A typo in the path returns 404 as a ~116 KB HTML page (R5b), so a source added
 * without this check sits in the list looking fine and fails on every Update.
 * Content type is the reliable signal: a real export is `application/octet-stream`.
 */
export async function verifyProjectUrl(url: string): Promise<void> {
  const ref = parseProjectUrl(url);
  const response = await fetch(exportUrl(ref.projectPath), { method: 'GET' });

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `${ref.projectPath} bir dışa aktarma döndürmüyor (HTTP ${response.status}). Adresi kontrol edin.`,
    );
  }

  const type = response.headers.get('content-type') ?? '';
  await response.body?.cancel();
  if (!type.includes('octet-stream')) {
    throw new Error(`${ref.projectPath} PO yerine "${type}" döndürdü. Adresi kontrol edin.`);
  }
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

export interface BulkTagChange {
  add?: readonly number[];
  remove?: readonly number[];
}

/**
 * Add or remove tags across many sources at once.
 *
 * The seeded list puts all 41 under one tag, and splitting it is the point —
 * giving WooCommerce its own tag is what makes `item` come out as `ürün` there.
 * Doing that one row at a time is the sort of chore people skip.
 */
export function bulkTagSources(db: Db, ids: readonly number[], change: BulkTagChange): number {
  const add = db.prepare(
    `INSERT OR IGNORE INTO trusted_source_tags (trusted_source_id, tag_id) VALUES (?, ?)`,
  );
  const remove = db.prepare(
    `DELETE FROM trusted_source_tags WHERE trusted_source_id = ? AND tag_id = ?`,
  );

  return db.transaction((): number => {
    let touched = 0;
    for (const id of ids) {
      for (const tagId of change.add ?? []) touched += add.run(id, tagId).changes;
      for (const tagId of change.remove ?? []) touched += remove.run(id, tagId).changes;
    }
    return touched;
  })();
}

/** Remove several sources, sweeping entries no remaining source vouches for. */
export function removeSources(db: Db, ids: readonly number[]): number {
  const drop = db.prepare(`DELETE FROM trusted_sources WHERE id = ?`);

  return db.transaction((): number => {
    let removed = 0;
    for (const id of ids) removed += drop.run(id).changes;

    db.prepare(
      `DELETE FROM glossary_entries
        WHERE origin = 'trusted' AND id NOT IN (SELECT entry_id FROM glossary_entry_sources)`,
    ).run();

    return removed;
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
  /** Terms taken from the official WordPress Turkish glossary. */
  glossaryTerms: number | null;
  /** True when only some sources were asked for, so the totals are partial. */
  partial: boolean;
  finishedAt: string | null;
}

const idle = (): SyncProgress => ({
  running: false,
  done: 0,
  total: 0,
  current: null,
  errors: [],
  glossaryTerms: null,
  partial: false,
  finishedAt: null,
});

let progress: SyncProgress = idle();

export const syncProgress = (): SyncProgress => progress;

/**
 * Re-fetch trusted sources and re-import them.
 *
 * Runs unattended (D17) and in the background: all 41 sources take half a minute
 * once paced, and the service rate-limits a tight loop (R24), so the panel polls
 * rather than waiting on one request.
 *
 * `ids` narrows the run to the sources the owner picked. A source that has just
 * been re-translated upstream is worth re-fetching on its own, and waiting for
 * the other forty to confirm it is not. The official term list is left alone in
 * that case: it is not one of these sources, and nothing about picking a few of
 * them says the terminology is stale.
 */
export function startSync(db: Db, ids?: readonly number[]): SyncProgress {
  if (progress.running) return progress;

  const partial = ids !== undefined && ids.length > 0;
  const wanted = partial ? new Set(ids) : null;
  const sources = listSources(db).filter((source) => wanted === null || wanted.has(source.id));
  // +1 for the official glossary on a full run, refreshed alongside: it is the
  // same kind of work from the owner's side, and forgetting it would leave the
  // terminology stale while the memory moved on.
  progress = {
    ...idle(),
    running: true,
    partial,
    total: sources.length + (partial ? 0 : 1),
  };

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

    if (!partial) {
      progress.current = 'WordPress Türkçe sözlüğü';
      try {
        const csv = await (await fetch(OFFICIAL_GLOSSARY_CSV)).text();
        const result = importOfficialGlossary(db, parseGlossaryCsv(csv), defaultTagId(db));
        progress.glossaryTerms = result.added + result.kept;
      } catch (error) {
        progress.errors.push({
          source: 'official glossary',
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
