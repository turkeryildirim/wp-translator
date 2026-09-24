import type { Db } from '../db/open.ts';
import type { Catalogue } from '../po/types.ts';
import { sourceHash } from './key.ts';

export interface SyncResult {
  syncRunId: number;
  entriesSeen: number;
  linksRemoved: number;
  entriesRemoved: number;
}

/**
 * Import a trusted source's catalogue into the glossary.
 *
 * Runs unattended (D17): entries already present are updated, new ones added,
 * and anything the source no longer carries is dropped. Nothing asks for
 * confirmation.
 *
 * Rows that differ only by context and agree on the translation are merged into
 * one context-less row (R27, `collapse.ts`). That merge has to hold across
 * updates, so this import is aware of it: a context whose translation the
 * context-less row already gives is not re-created, and its vouch goes to that
 * row. Otherwise every update would rebuild the contextful rows, strip the
 * merged row of its support, and sweep it away with the provenance of every
 * unit filled from it.
 *
 * The drop removes this source's *link*, not the entry. Several trusted sources
 * carry the same string — `Save` and `Cancel` are in core and in most plugins,
 * and WooCommerce alone shares 643 entries with core — so an entry survives
 * while any source still vouches for it (R14).
 *
 * Only translated entries are taken: an untranslated source string teaches the
 * glossary nothing.
 */
export function syncTrustedSource(
  db: Db,
  trustedSourceId: number,
  catalogue: Catalogue,
  tagIds: readonly number[],
): SyncResult {
  const statements = prepare(db);

  return db.transaction((): SyncResult => {
    const syncRunId = Number(statements.beginRun.run(trustedSourceId).lastInsertRowid);
    let entriesSeen = 0;

    for (const unit of catalogue.units) {
      const translation = unit.msgstr;
      if (!translation) continue;

      const hash = sourceHash(unit.msgid, unit.msgidPlural);
      for (const tagId of tagIds) {
        statements.insertEntry.run({
          hash,
          text: unit.msgid,
          plural: unit.msgidPlural ?? null,
          msgctxt: unit.msgctxt ?? null,
          tagId,
          translation,
          translationPlural: unit.msgstrPlural ?? null,
        });
        statements.linkSource.run({
          hash,
          msgctxt: unit.msgctxt ?? null,
          tagId,
          trustedSourceId,
          translation,
          translationPlural: unit.msgstrPlural ?? null,
          syncRunId,
        });
        entriesSeen += 1;
      }
    }

    const linksRemoved = statements.sweepLinks.run(trustedSourceId, syncRunId).changes;
    const entriesRemoved = statements.sweepEntries.run().changes;
    statements.resolveTranslations.run();
    statements.finishRun.run(entriesSeen, syncRunId);
    statements.markSynced.run(syncRunId, trustedSourceId);

    return { syncRunId, entriesSeen, linksRemoved, entriesRemoved };
  })();
}

/**
 * Exported for the query-plan test, which is the only guard against this
 * module's statements quietly losing their index — the failure is invisible in
 * behaviour and only shows up as the server ceasing to answer.
 */
export function prepare(db: Db) {
  return {
    beginRun: db.prepare(`INSERT INTO sync_runs (trusted_source_id) VALUES (?)`),

    finishRun: db.prepare(
      `UPDATE sync_runs SET finished_at = datetime('now'), status = 'ok', entries_seen = ?
       WHERE id = ?`,
    ),

    markSynced: db.prepare(
      `UPDATE trusted_sources SET last_sync_id = ?, last_synced_at = datetime('now')
       WHERE id = ?`,
    ),

    // The entry itself carries no translation yet — resolveTranslations decides
    // it from the links, so the result does not depend on which source synced
    // last.
    //
    // A context this source carries may already be answered by a context-less
    // row that an earlier merge left behind (R27). Re-creating it would undo
    // that merge on every update: the merged row would lose its vouches to the
    // new rows, the sweep would delete it, and every unit filled from it would
    // lose its provenance. So a source that agrees with the context-less row
    // adds nothing; one that disagrees still gets its own contextful row, and
    // the merge then leaves the pair alone.
    insertEntry: db.prepare(
      `INSERT INTO glossary_entries
         (source_hash, source_text, source_plural, msgctxt, tag_id,
          translation, translation_plural, origin)
       SELECT @hash, @text, @plural, @msgctxt, @tagId, @translation, @translationPlural, 'trusted'
        WHERE NOT EXISTS (
              SELECT 1 FROM glossary_entries
               WHERE source_hash = @hash AND ifnull(msgctxt, '') = '' AND tag_id = @tagId
                 AND pos IS NULL
                 AND translation = @translation
                 AND ifnull(translation_plural, '') = ifnull(@translationPlural, ''))
       ON CONFLICT (source_hash, ifnull(msgctxt, ''), tag_id) WHERE pos IS NULL DO NOTHING`,
    ),

    // Vouches for the row the entry actually landed on: its own context when
    // one exists, otherwise the agreeing context-less row it was merged into.
    // Without the second case the vouch would find nothing, the merged row
    // would look unsupported, and the sweep would delete it.
    //
    // Two seeks joined by coalesce, never one lookup with `OR`. Both arms match
    // `idx_glossary_memory_key` on all three of its columns; the `OR` form
    // matched none of it and fell back to scanning `idx_glossary_tag`, which is
    // every row in the glossary because almost all of them share one tag. At
    // 50 000 rows a scan per string, a WooCommerce sync stopped answering
    // altogether — better-sqlite3 is synchronous, so it takes the server with
    // it. The index wants `ifnull(msgctxt, '')`, so `msgctxt IS NULL` has to be
    // written that way here even though it reads worse.
    linkSource: db.prepare(
      `INSERT INTO glossary_entry_sources (entry_id, trusted_source_id, translation, last_seen_sync_id)
       SELECT entry_id, @trustedSourceId, @translation, @syncRunId
         FROM (SELECT coalesce(
                 (SELECT id FROM glossary_entries
                   WHERE source_hash = @hash AND ifnull(msgctxt, '') = ifnull(@msgctxt, '')
                     AND tag_id = @tagId AND pos IS NULL),
                 (SELECT id FROM glossary_entries
                   WHERE source_hash = @hash AND ifnull(msgctxt, '') = '' AND tag_id = @tagId
                     AND pos IS NULL
                     AND translation = @translation
                     AND ifnull(translation_plural, '') = ifnull(@translationPlural, ''))
               ) AS entry_id)
        WHERE entry_id IS NOT NULL
       ON CONFLICT (entry_id, trusted_source_id) DO UPDATE SET
         translation = excluded.translation,
         last_seen_sync_id = excluded.last_seen_sync_id`,
    ),

    sweepLinks: db.prepare(
      `DELETE FROM glossary_entry_sources
        WHERE trusted_source_id = ? AND last_seen_sync_id < ?`,
    ),

    // An entry the owner approved stays even with no trusted source behind it.
    sweepEntries: db.prepare(
      `DELETE FROM glossary_entries
        WHERE origin = 'trusted'
          AND id NOT IN (SELECT entry_id FROM glossary_entry_sources)`,
    ),

    // Majority of vouching sources wins; ties fall to the owner's ranking (D36).
    // Measured over five sources, 88% of disagreements are two-way ties, so the
    // ranking is what actually decides (R15).
    resolveTranslations: db.prepare(
      `UPDATE glossary_entries SET translation = (
         SELECT s.translation
           FROM glossary_entry_sources s
           JOIN trusted_sources t ON t.id = s.trusted_source_id
          WHERE s.entry_id = glossary_entries.id
          GROUP BY s.translation
          ORDER BY count(*) DESC, min(t.rank) ASC, min(t.id) ASC
          LIMIT 1)
       WHERE origin = 'trusted'
         AND EXISTS (SELECT 1 FROM glossary_entry_sources WHERE entry_id = glossary_entries.id)`,
    ),
  };
}
