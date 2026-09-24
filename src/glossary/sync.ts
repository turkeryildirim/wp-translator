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
 * An entry is a source and a translation; context is not part of its identity
 * (D44). Two sources that translate one string the same way meet on one row
 * however differently they label it, and two that disagree sit side by side as
 * the alternatives they are. Contexts are kept alongside, as a record of where
 * a translation has been seen.
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
        const key = {
          hash,
          tagId,
          translation,
          translationPlural: unit.msgstrPlural ?? null,
        };
        statements.insertEntry.run({
          ...key,
          text: unit.msgid,
          plural: unit.msgidPlural ?? null,
        });
        statements.linkSource.run({ ...key, trustedSourceId, syncRunId });
        if (unit.msgctxt) statements.recordContext.run({ ...key, msgctxt: unit.msgctxt });
        entriesSeen += 1;
      }
    }

    const linksRemoved = statements.sweepLinks.run(trustedSourceId, syncRunId).changes;
    const entriesRemoved = statements.sweepEntries.run().changes;
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

    // Source and translation are the identity, so a string every source renders
    // the same way is one row no matter how many contexts it arrived under.
    insertEntry: db.prepare(
      `INSERT INTO glossary_entries
         (source_hash, source_text, source_plural, msgctxt, tag_id,
          translation, translation_plural, origin)
       VALUES (@hash, @text, @plural, NULL, @tagId, @translation, @translationPlural, 'trusted')
       ON CONFLICT (source_hash, translation, ifnull(translation_plural, ''), tag_id)
         WHERE pos IS NULL DO NOTHING`,
    ),

    // Both of these run once per string per tag — 58 000 times in a full
    // update — so both must reach the row by index. They spell the key exactly
    // as idx_glossary_memory_key is built; anything the index cannot serve
    // falls back to scanning the whole glossary, and better-sqlite3 is
    // synchronous, so the server stops answering rather than merely slowing
    // down (R28). `test/sync-plan.test.ts` holds them to it.
    linkSource: db.prepare(
      `INSERT INTO glossary_entry_sources (entry_id, trusted_source_id, translation, last_seen_sync_id)
       SELECT id, @trustedSourceId, @translation, @syncRunId
         FROM glossary_entries
        WHERE source_hash = @hash AND translation = @translation
          AND ifnull(translation_plural, '') = ifnull(@translationPlural, '')
          AND tag_id = @tagId AND pos IS NULL
       ON CONFLICT (entry_id, trusted_source_id) DO UPDATE SET
         last_seen_sync_id = excluded.last_seen_sync_id`,
    ),

    // Where this translation has been seen. Not a key, and never read by
    // matching — it answers "why does the glossary offer this?" when two
    // translations of one string sit next to each other.
    recordContext: db.prepare(
      `INSERT OR IGNORE INTO glossary_entry_contexts (entry_id, msgctxt)
       SELECT id, @msgctxt FROM glossary_entries
        WHERE source_hash = @hash AND translation = @translation
          AND ifnull(translation_plural, '') = ifnull(@translationPlural, '')
          AND tag_id = @tagId AND pos IS NULL`,
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

  };
}
