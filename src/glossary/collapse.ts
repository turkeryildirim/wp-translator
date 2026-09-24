import type { Db } from '../db/open.ts';

/**
 * Merge glossary rows that differ only by `msgctxt` and agree on the translation.
 *
 * Trusted sources carry the same string under many contexts. `&larr;` arrived
 * under eight of them — seven BuddyPress pagination labels and a core post
 * link — all translated `&larr;`. Nothing distinguishes those rows, and the
 * cost is not only clutter: `applyGlossary` matches a context-less unit against
 * context-less rows *only*, so a plain `&larr;` matched none of the eight while
 * all eight said the same thing.
 *
 * Measured over 53 211 memory rows, the (source, tag) groups holding more than
 * one row split three ways: 839 agree with no context-less row among them
 * (these gain a match that did not exist), 934 agree and already have one
 * (these are pure redundancy), and 955 genuinely disagree — `Cancel` is
 * `İptal`, `İptal Et` and `Vazgeç` depending on context, which is the
 * distinction `msgctxt` exists to make (R27).
 *
 * So the rule is agreement, not similarity: a group collapses only when every
 * row gives the same translation *and* the same plural. The survivor loses its
 * context and answers every lookup through the fallback; the rest are deleted
 * after their vouches move across, since a vouch is what keeps an entry alive
 * (R14) and `ON DELETE CASCADE` would otherwise take it with the row.
 *
 * Idempotent: a second run finds no group of more than one row left to merge.
 *
 * @returns how many rows were removed.
 */
export function collapseAgreedContexts(db: Db): number {
  return db.transaction((): number => {
    const before = memoryRows(db);
    db.exec(collapseSql());
    return before - memoryRows(db);
  })();
}

const memoryRows = (db: Db): number =>
  (db.prepare(`SELECT count(*) AS n FROM glossary_entries WHERE pos IS NULL`).get() as { n: number })
    .n;

/**
 * The whole merge as one statement list, so the migration that cleans an
 * existing database and the sync that keeps it clean cannot drift apart.
 *
 * Carries no `BEGIN`: both callers already run inside a transaction.
 *
 * The grouping runs over an indexed temp copy rather than `glossary_entries`
 * directly. The table's indexes lead with `tag_id` or `source_text`, so
 * grouping by `(source_hash, tag_id)` degrades into a self-join over a
 * materialised CTE — measured at 30 s, against 0.23 s for the copy.
 */
export const collapseSql = (): string => `
  CREATE TEMP TABLE mem AS
    SELECT id, source_hash, tag_id, msgctxt, translation,
           ifnull(translation_plural, '') AS tp
      FROM glossary_entries WHERE pos IS NULL;
  CREATE INDEX temp.idx_mem ON mem (source_hash, tag_id);

  CREATE TEMP TABLE merge_map AS
  WITH grp AS (
    SELECT source_hash, tag_id,
           count(DISTINCT translation || char(31) || tp) AS variants,
           -- An existing context-less row is the natural survivor: keeping it
           -- means no surviving row has to change its key.
           min(CASE WHEN msgctxt IS NULL THEN id END) AS ctxless_id,
           min(id) AS any_id
      FROM mem
     GROUP BY source_hash, tag_id
    HAVING count(*) > 1 AND variants = 1)
  SELECT m.id AS drop_id, coalesce(g.ctxless_id, g.any_id) AS keep_id
    FROM grp g
    JOIN mem m ON m.source_hash = g.source_hash AND m.tag_id = g.tag_id
   WHERE m.id <> coalesce(g.ctxless_id, g.any_id);

  CREATE INDEX temp.idx_map ON merge_map (drop_id);

  -- Vouches first: a vouch is what keeps an entry alive (R14), and the
  -- CASCADE on the delete below would otherwise take them with the row. Two
  -- merged rows can carry the same source, so the survivor keeps the later
  -- sighting; an older one would look stale to the next sweep.
  INSERT INTO glossary_entry_sources (entry_id, trusted_source_id, translation, last_seen_sync_id)
  SELECT p.keep_id, s.trusted_source_id, s.translation, s.last_seen_sync_id
    FROM glossary_entry_sources s
    JOIN merge_map p ON p.drop_id = s.entry_id
   WHERE true
  ON CONFLICT (entry_id, trusted_source_id) DO UPDATE SET
    last_seen_sync_id = max(excluded.last_seen_sync_id,
                            glossary_entry_sources.last_seen_sync_id);

  -- A unit filled from a row that is about to go keeps its provenance.
  UPDATE translation_units
     SET glossary_entry_id = (SELECT keep_id FROM merge_map WHERE drop_id = glossary_entry_id)
   WHERE glossary_entry_id IN (SELECT drop_id FROM merge_map);

  DELETE FROM glossary_entries WHERE id IN (SELECT drop_id FROM merge_map);

  UPDATE glossary_entries SET msgctxt = NULL, updated_at = datetime('now')
   WHERE msgctxt IS NOT NULL AND id IN (SELECT keep_id FROM merge_map);

  DROP TABLE temp.merge_map;
  DROP TABLE temp.mem;
`;
