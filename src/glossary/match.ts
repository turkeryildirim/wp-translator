import type { Db } from '../db/open.ts';

export interface MatchResult {
  /** Filled from the glossary and complete. */
  filled: number;
  /** Of those, how many had another translation on offer (D44). */
  alternatives: number;
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
 * A unit's `msgctxt` takes no part. It used to choose between entries, and
 * measured over three real plugins it decided *none* of the 281 matches it
 * could have: the contexts a glossary holds are the source project's own keys,
 * and they do not recur in someone else's plugin (R29). The answer came from
 * the context-less row every time, which meant the glossary quietly picked one
 * translation and hid the others.
 *
 * So every translation of a string is offered, best first, and the best one is
 * filled in. Best is the owner's own entry, then the one the most trusted
 * sources vouch for, then the one the highest-ranked source carries (D36).
 * Measured, that agrees with what the old context-less row gave in 91 % of the
 * cases where it could differ, and where it differs it is usually the better
 * supported reading — `Mail` becomes `E-posta` rather than `Posta`.
 *
 * Rows carrying a `pos` are skipped. Those come from the official WordPress
 * glossary and are *terminology*, curated to tell the model how a word is
 * rendered — not approved translations of a whole string in an unknown context.
 * They reach the model through `collectTerms` instead.
 */
export function applyGlossary(db: Db, projectId: number): MatchResult {
  const tagIds = db
    .prepare(`SELECT tag_id FROM project_tags WHERE project_id = ?`)
    .all(projectId)
    .map((row) => (row as { tag_id: number }).tag_id);

  const result: MatchResult = { filled: 0, alternatives: 0, unmatched: 0 };
  if (tagIds.length === 0) {
    result.unmatched = countUntranslated(db, projectId);
    return result;
  }

  const placeholders = tagIds.map(() => '?').join(', ');
  const candidatesFor = db.prepare(
    `SELECT e.id AS entryId, e.translation, e.translation_plural AS translationPlural
       FROM glossary_entries e
       LEFT JOIN glossary_entry_sources s ON s.entry_id = e.id
       LEFT JOIN trusted_sources t ON t.id = s.trusted_source_id
      WHERE e.source_hash = ? AND e.pos IS NULL AND e.tag_id IN (${placeholders})
      GROUP BY e.id
      ORDER BY (e.origin = 'owner') DESC,
               count(DISTINCT s.trusted_source_id) DESC,
               ifnull(min(t.rank), 2147483647) ASC,
               e.id ASC`,
  );
  const units = db.prepare(
    `SELECT id, source_hash AS hash FROM translation_units
      WHERE project_id = ? AND state = 'untranslated'`,
  );
  // `blocked` is reset rather than computed: a glossary entry is a translation
  // a human already approved of this exact source, so there is nothing for the
  // checks to find that was not already there.
  const fill = db.prepare(
    `UPDATE translation_units
        SET msgstr = @translation, msgstr_plural = @translationPlural,
            state = 'ok', provenance = 'glossary', glossary_entry_id = @entryId,
            blocked = 0, updated_at = datetime('now')
      WHERE id = @id`,
  );

  return db.transaction((): MatchResult => {
    for (const row of units.all(projectId) as { id: number; hash: string }[]) {
      const candidates = distinct(candidatesFor.all(row.hash, ...tagIds) as Candidate[]);

      if (candidates.length === 0) {
        result.unmatched += 1;
        continue;
      }

      fill.run({ id: row.id, ...candidates[0]! });
      result.filled += 1;
      if (candidates.length > 1) result.alternatives += 1;
    }

    return result;
  })();
}

/**
 * One entry per wording, best first.
 *
 * Two tags can hold the same translation of a string — most do — and that is
 * not a choice to put in front of the owner. Only a different wording is.
 */
function distinct(candidates: readonly Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.translation}\u001f${candidate.translationPlural ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function countUntranslated(db: Db, projectId: number): number {
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM translation_units WHERE project_id = ? AND state = 'untranslated'`,
    )
    .get(projectId) as { n: number };
  return row.n;
}
