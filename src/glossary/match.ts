import type { Db } from '../db/open.ts';

export interface MatchResult {
  /** Filled from the glossary and complete. */
  filled: number;
  /** Of those, how many had another translation on offer. */
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
 * Fill a project's untranslated units from the glossary, best translation first.
 *
 * Matching is byte-exact on the source string and ignores `msgctxt`; where a
 * string has several known translations the best-supported one is filled in and
 * the rest are offered as candidates. Terminology rows (`pos IS NOT NULL`) are
 * skipped — they say how a word is rendered, not how a whole string is.
 *
 * @param ids narrows it to these units; without it, every untranslated one.
 */
export function applyGlossary(db: Db, projectId: number, ids?: readonly number[]): MatchResult {
  const tagIds = db
    .prepare(`SELECT tag_id FROM project_tags WHERE project_id = ?`)
    .all(projectId)
    .map((row) => (row as { tag_id: number }).tag_id);

  const result: MatchResult = { filled: 0, alternatives: 0, unmatched: 0 };
  if (tagIds.length === 0) {
    result.unmatched = countUntranslated(db, projectId);
    return result;
  }
  if (ids?.length === 0) return result;

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
  const scope = ids ? ` AND id IN (${ids.map(() => '?').join(', ')})` : '';
  const units = db.prepare(
    `SELECT id, source_hash AS hash FROM translation_units
      WHERE project_id = ? AND state = 'untranslated'${scope}`,
  );
  // A glossary entry is a translation a human approved of this exact source, so
  // there is nothing for the checks to find.
  const fill = db.prepare(
    `UPDATE translation_units
        SET msgstr = @translation, msgstr_plural = @translationPlural,
            state = 'ok', provenance = 'glossary', glossary_entry_id = @entryId,
            blocked = 0, updated_at = datetime('now')
      WHERE id = @id`,
  );

  return db.transaction((): MatchResult => {
    for (const row of units.all(projectId, ...(ids ?? [])) as { id: number; hash: string }[]) {
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

/** One entry per wording: the same translation under two tags is not a choice. */
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
