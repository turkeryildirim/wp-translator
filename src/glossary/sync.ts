import type { Db } from '../db/open.ts';
import type { Catalogue } from '../po/types.ts';
import { sourceHash } from './key.ts';
import { affixes } from '../text/whitespace.ts';

export interface SyncResult {
  syncRunId: number;
  /** Rows the source carries, after its own duplicates meet on one entry. */
  entriesSeen: number;
  /** Of those, rows that did not exist before this run. */
  entriesAdded: number;
  linksRemoved: number;
  entriesRemoved: number;
}

/**
 * Import a trusted source's catalogue into the glossary, unattended.
 *
 * An entry is identified by its source *and* its translation, so sources that
 * agree meet on one row and sources that differ sit side by side; contexts are
 * recorded alongside but are not part of the key. Dropping a string removes
 * this source's link, not the entry, which survives while any source still
 * vouches for it.
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
    let entriesAdded = 0;

    for (const unit of catalogue.units) {
      // Stored without its surrounding whitespace: that is shape, and keeping it
      // filled the glossary with rows that say the same thing. Matching strips
      // the same way and restores the shape from the unit being filled.
      const translation = affixes(unit.msgstr ?? '').core;
      if (!translation) continue;

      const source = affixes(unit.msgid).core;
      const sourcePlural = unit.msgidPlural ? affixes(unit.msgidPlural).core : undefined;
      const hash = sourceHash(source, sourcePlural);
      for (const tagId of tagIds) {
        const key = {
          hash,
          tagId,
          translation,
          translationPlural: unit.msgstrPlural ? affixes(unit.msgstrPlural).core || null : null,
        };
        // `changes` is 1 only when the row was created: the conflict clause makes
        // a repeat a no-op, which is what tells a re-sync that found nothing new
        // from one that did not run.
        entriesAdded += statements.insertEntry.run({
          ...key,
          text: source,
          plural: sourcePlural ?? null,
        }).changes;
        statements.linkSource.run({ ...key, trustedSourceId, syncRunId });
        if (unit.msgctxt) statements.recordContext.run({ ...key, msgctxt: unit.msgctxt });
        entriesSeen += 1;
      }
    }

    const linksRemoved = statements.sweepLinks.run(trustedSourceId, syncRunId).changes;
    const entriesRemoved = statements.sweepEntries.run().changes;
    statements.finishRun.run(entriesSeen, syncRunId);
    statements.markSynced.run(syncRunId, trustedSourceId);

    return { syncRunId, entriesSeen, entriesAdded, linksRemoved, entriesRemoved };
  })();
}

/** Exported so `test/sync-plan.test.ts` can check these statements' query plans. */
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

    insertEntry: db.prepare(
      `INSERT INTO glossary_entries
         (source_hash, source_text, source_plural, msgctxt, tag_id,
          translation, translation_plural, origin)
       VALUES (@hash, @text, @plural, NULL, @tagId, @translation, @translationPlural, 'trusted')
       ON CONFLICT (source_hash, translation, ifnull(translation_plural, ''), tag_id)
         WHERE pos IS NULL DO NOTHING`,
    ),

    // Runs once per string per tag, so it must reach the row by index: it spells
    // the key exactly as idx_glossary_memory_key is built.
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

    // Where this translation has been seen. Never read by matching; it answers
    // why the glossary offers two translations of one string.
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
