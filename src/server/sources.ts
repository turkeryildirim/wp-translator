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
import { fetchProjectStats, type GlotPressStats } from '../wporg/stats.ts';

export interface TrustedSourceRow {
  id: number;
  translateUrl: string;
  projectPath: string;
  family: string;
  label: string | null;
  /** Lower wins when sources disagree. Ties are the common case. */
  rank: number;
  lastSyncedAt: string | null;
  entries: number;
  tagIds: number[];
  translated: number;
  fuzzy: number;
  waiting: number;
  untranslated: number;
  totalStrings: number;
  percent: number;
  existingProjectId?: number | null;
}

export function listSources(db: Db): TrustedSourceRow[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.translate_url AS translateUrl, s.project_path AS projectPath,
              s.family, s.label, s.rank, s.last_synced_at AS lastSyncedAt,
              ifnull(s.translated, 0) AS translated,
              ifnull(s.fuzzy, 0) AS fuzzy,
              ifnull(s.waiting, 0) AS waiting,
              ifnull(s.untranslated, 0) AS untranslated,
              ifnull(s.total_strings, 0) AS totalStrings,
              ifnull(s.percent, 0) AS percent,
              count(DISTINCT l.entry_id) AS entries
         FROM trusted_sources s
         LEFT JOIN glossary_entry_sources l ON l.trusted_source_id = s.id
        GROUP BY s.id
        ORDER BY s.rank, s.id`,
    )
    .all() as Omit<TrustedSourceRow, 'tagIds' | 'existingProjectId'>[];

  const tags = db.prepare(`SELECT trusted_source_id AS id, tag_id AS tagId FROM trusted_source_tags`)
    .all() as { id: number; tagId: number }[];

  const bySource = new Map<number, number[]>();
  for (const tag of tags) bySource.set(tag.id, [...(bySource.get(tag.id) ?? []), tag.tagId]);

  const projects = db
    .prepare(
      `SELECT id, translate_url AS translateUrl, project_path AS projectPath, sub_project AS subProject
         FROM projects`,
    )
    .all() as { id: number; translateUrl: string; projectPath: string; subProject: string | null }[];

  const projectByUrl = new Map<string, number>();
  const projectByPath = new Map<string, number>();
  for (const p of projects) {
    projectByUrl.set(p.translateUrl, p.id);
    projectByPath.set(`${p.projectPath}:${p.subProject ?? ''}`, p.id);
  }

  return rows.map((row) => {
    let existingProjectId: number | null = projectByUrl.get(row.translateUrl) ?? null;
    if (existingProjectId === null) {
      const ref = parseProjectUrl(row.translateUrl);
      existingProjectId = projectByPath.get(`${ref.projectPath}:${ref.subProject ?? ''}`) ?? null;
    }
    return {
      ...row,
      existingProjectId,
      tagIds: bySource.get(row.id) ?? [],
    };
  });
}

/** Where the official glossary's terms land. The seeded tag, or the first one. */
export function defaultTagId(db: Db): number {
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
 * A typo in the path returns 404 as a large HTML page, so the content type is
 * the reliable signal: a real export is `application/octet-stream`.
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

  // A source is the project, not the address it was pasted from: the same project
  // reaches here as several URLs — with or without the locale segment, through the
  // locale listing page, with a query string — and each would be synced separately
  // and vouch for its own entries twice.
  const already = db
    .prepare(`SELECT label, translate_url AS url FROM trusted_sources WHERE project_path = ?`)
    .get(ref.projectPath) as { label: string | null; url: string } | undefined;
  if (already) {
    throw new Error(
      `Bu proje güvenilir kaynaklarda zaten var: ${already.label ?? ref.projectPath} (${already.url})`,
    );
  }

  // A source with no tag imports nothing: the sync loops over its tags, so an empty
  // list means the inner loop never runs and the run reports success having done
  // nothing at all. Everything starts under one tag; splitting comes later.
  const tags = tagIds.length > 0 ? tagIds : [defaultTagId(db)];

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
    for (const tagId of tags) link.run(id, tagId);

    return id;
  })();
}

export interface BulkTagChange {
  add?: readonly number[];
  remove?: readonly number[];
}

/**
 * Add or remove tags across many sources at once, since splitting the seeded
 * single tag is the point and doing it row by row is a chore people skip.
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

    // Renumber remaining ranks 1..N so gaps are eliminated in DB
    const remaining = db.prepare(`SELECT id FROM trusted_sources ORDER BY rank ASC, id ASC`).all() as {
      id: number;
    }[];
    const updateRank = db.prepare(`UPDATE trusted_sources SET rank = ? WHERE id = ?`);
    remaining.forEach((row, idx) => {
      updateRank.run(idx + 1, row.id);
    });

    return removed;
  })();
}

/** Reorder by rank. The order is what actually decides most disagreements. */
export function reorderSources(db: Db, ids: readonly number[]): void {
  const update = db.prepare(`UPDATE trusted_sources SET rank = ? WHERE id = ?`);
  db.transaction(() => {
    ids.forEach((id, index) => update.run(index + 1, id));
  })();
}

/** Update GlotPress live statistics for a specific source. */
export async function updateSourceStats(db: Db, id: number, url?: string): Promise<GlotPressStats | null> {
  const row = db.prepare(`SELECT translate_url AS url FROM trusted_sources WHERE id = ?`).get(id) as
    | { url: string }
    | undefined;
  const targetUrl = url ?? row?.url;
  if (!targetUrl) return null;

  try {
    const stats = await fetchProjectStats(targetUrl);
    db.prepare(
      `UPDATE trusted_sources
          SET translated = ?, fuzzy = ?, waiting = ?, untranslated = ?, total_strings = ?, percent = ?, last_synced_at = datetime('now')
        WHERE id = ?`,
    ).run(stats.translated, stats.fuzzy, stats.waiting, stats.untranslated, stats.total, stats.percent, id);
    return stats;
  } catch {
    return null;
  }
}

/**
 * Refresh stats across all or selected sources without re-downloading entire POs.
 */
export async function refreshSourcesStats(db: Db, ids?: readonly number[]): Promise<{ updated: number }> {
  const sources = listSources(db).filter((s) => ids === undefined || ids.includes(s.id));
  let updated = 0;
  for (const s of sources) {
    const res = await updateSourceStats(db, s.id, s.translateUrl);
    if (res !== null) updated += 1;
  }
  return { updated };
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
  /**
   * What each source's run did.
   *
   * A source that has not changed upstream adds nothing, which looks exactly like
   * a run that did not happen unless it is said out loud.
   */
  results: SyncOutcome[];
  finishedAt: string | null;
}

export interface SyncOutcome {
  source: string;
  seen: number;
  added: number;
  linksRemoved: number;
  entriesRemoved: number;
}

const idle = (): SyncProgress => ({
  running: false,
  results: [],
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
 * Re-fetch trusted sources and re-import them, unattended and in the
 * background; the service rate-limits a tight loop, so the panel polls.
 *
 * @param ids narrows the run to these sources and leaves the official term
 * list alone, since it is not one of them.
 */
export function startSync(db: Db, ids?: readonly number[]): SyncProgress {
  if (progress.running) return progress;

  const partial = ids !== undefined && ids.length > 0;
  const wanted = partial ? new Set(ids) : null;
  const sources = listSources(db).filter((source) => wanted === null || wanted.has(source.id));
  // +1 for the official glossary, refreshed alongside on a full run.
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
        const result = syncTrustedSource(db, source.id, parsePo(po), source.tagIds);
        progress.results.push({
          source: source.label ?? source.projectPath,
          seen: result.entriesSeen,
          added: result.entriesAdded,
          linksRemoved: result.linksRemoved,
          entriesRemoved: result.entriesRemoved,
        });
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
