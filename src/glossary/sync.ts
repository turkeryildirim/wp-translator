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

function prepare(db: Db) {
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

    // The entry itself carries no translation yet — resolveTranslations decides it
    // from the links, so that the result does not depend on which source synced last.
    insertEntry: db.prepare(
      `INSERT INTO glossary_entries
         (source_hash, source_text, source_plural, msgctxt, tag_id,
          translation, translation_plural, origin)
       VALUES (@hash, @text, @plural, @msgctxt, @tagId, @translation, @translationPlural, 'trusted')
       ON CONFLICT (source_hash, ifnull(msgctxt, ''), tag_id) WHERE pos IS NULL DO NOTHING`,
    ),

    linkSource: db.prepare(
      `INSERT INTO glossary_entry_sources (entry_id, trusted_source_id, translation, last_seen_sync_id)
       SELECT id, @trustedSourceId, @translation, @syncRunId
         FROM glossary_entries
        WHERE source_hash = @hash AND ifnull(msgctxt, '') = ifnull(@msgctxt, '')
          AND pos IS NULL AND tag_id = @tagId
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
