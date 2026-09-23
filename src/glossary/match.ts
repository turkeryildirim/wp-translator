import type { Db } from '../db/open.ts';

export interface MatchResult {
  /** Filled from the glossary and complete. */
  filled: number;
  /** Several of the project's tags offered different translations; the owner chooses. */
  ambiguous: number;
  /** No glossary entry; these go to the AI. */
  unmatched: number;
}

interface Candidate {
  entryId: number;
  translation: string;
  translationPlural: string | null;
}

/**
 * Fill a project's units from the glossary.
 *
 * Matching is byte-exact on the source string — no normalisation. Measured over
 * WooCommerce's 14 159 distinct sources, lowercasing would gain 253 matches of
 * which 197 map to a *different* translation, and nothing malformed exists for
 * the quality checks to catch, so a wrong match is silent (R13).
 *
 * A unit carrying `msgctxt` prefers entries under that context and falls back to
 * the context-less one. A unit without context matches only context-less
 * entries: falling back to an arbitrary context-bearing entry is exactly the
 * collapse the glossary key exists to prevent.
 */
export function applyGlossary(db: Db, projectId: number): MatchResult {
  const tagIds = db
    .prepare(`SELECT tag_id FROM project_tags WHERE project_id = ?`)
    .all(projectId)
    .map((row) => (row as { tag_id: number }).tag_id);

  const result: MatchResult = { filled: 0, ambiguous: 0, unmatched: 0 };
  if (tagIds.length === 0) {
    result.unmatched = countUntranslated(db, projectId);
    return result;
  }

  const placeholders = tagIds.map(() => '?').join(', ');
  const candidatesFor = db.prepare(
    `SELECT id AS entryId, translation, translation_plural AS translationPlural
       FROM glossary_entries
      WHERE source_hash = ? AND ifnull(msgctxt, '') = ? AND tag_id IN (${placeholders})`,
  );
  const units = db.prepare(
    `SELECT id, source_hash AS hash, msgctxt FROM translation_units
      WHERE project_id = ? AND state = 'untranslated'`,
  );
  const fill = db.prepare(
    `UPDATE translation_units
        SET msgstr = @translation, msgstr_plural = @translationPlural,
            state = 'ok', provenance = 'glossary', glossary_entry_id = @entryId,
            updated_at = datetime('now')
      WHERE id = @id`,
  );
  const flagAmbiguous = db.prepare(
    `UPDATE translation_units
        SET state = 'review', provenance = 'glossary', updated_at = datetime('now')
      WHERE id = ?`,
  );

  return db.transaction((): MatchResult => {
    for (const row of units.all(projectId) as { id: number; hash: string; msgctxt: string | null }[]) {
      const candidates = lookup(candidatesFor, row.hash, row.msgctxt, tagIds);

      if (candidates.length === 0) {
        result.unmatched += 1;
        continue;
      }

      const distinct = new Set(candidates.map((c) => c.translation));
      if (distinct.size > 1) {
        // The tags disagree, which is the distinction domain tags exist to make.
        // Choosing one here would be a coin toss, so the owner decides (D37).
        flagAmbiguous.run(row.id);
        result.ambiguous += 1;
        continue;
      }

      fill.run({ id: row.id, ...candidates[0]! });
      result.filled += 1;
    }

    return result;
  })();
}

/** Candidates for a unit, preferring its own context and falling back to none. */
function lookup(
  statement: { all(...params: unknown[]): unknown[] },
  hash: string,
  msgctxt: string | null,
  tagIds: readonly number[],
): Candidate[] {
  if (msgctxt !== null) {
    const withContext = statement.all(hash, msgctxt, ...tagIds) as Candidate[];
    if (withContext.length > 0) return withContext;
  }
  return statement.all(hash, '', ...tagIds) as Candidate[];
}

function countUntranslated(db: Db, projectId: number): number {
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM translation_units WHERE project_id = ? AND state = 'untranslated'`,
    )
    .get(projectId) as { n: number };
  return row.n;
}
