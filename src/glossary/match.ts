import type Database from 'better-sqlite3';
import type { Db } from '../db/open.ts';
import { sourceHash, sourceVariantHash } from './key.ts';
import { affixes, reapply } from '../text/whitespace.ts';
import { defaultTagId } from '../server/sources.ts';
import { checkTranslation } from '../quality/check.ts';

export interface MatchResult {
  /** Filled from the glossary and complete. */
  filled: number;
  /** Of those, how many had another translation on offer. */
  alternatives: number;
  /** No glossary entry; these go to the AI. */
  unmatched: number;
}

export interface ApplyGlossaryOptions {
  /** Narrows it to these units; without it, untranslated ones. */
  ids?: readonly number[] | undefined;
  /** Target state: 'review' (bekleyen) or 'ok' (onaylanan). Default: 'ok'. */
  state?: 'ok' | 'review' | undefined;
  /**
   * If true, allows matching glossary entries across any tag in the glossary,
   * prioritizing project tags, base tag, and trusted sources.
   */
  fallbackAnyTag?: boolean | undefined;
}

interface Candidate {
  entryId: number;
  translation: string;
  translationPlural: string | null;
}

/**
 * Fill a project's units from the glossary, best translation first.
 *
 * Matching tries the exact source first, then its edge/case variants, and ignores `msgctxt`; where a
 * string has several known translations the best-supported one is filled in and
 * the rest are offered as candidates. Terminology rows (`pos IS NOT NULL`) are
 * skipped — they say how a word is rendered, not how a whole string is.
 *
 * @param optionsOrIds narrows it to these units or options; without it, every untranslated one.
 */
export function applyGlossary(
  db: Db,
  projectId: number,
  optionsOrIds?: readonly number[] | ApplyGlossaryOptions,
): MatchResult {
  const options: ApplyGlossaryOptions = !optionsOrIds
    ? {}
    : Array.isArray(optionsOrIds)
      ? { ids: optionsOrIds }
      : (optionsOrIds as ApplyGlossaryOptions);

  const ids = options.ids;
  const targetState = options.state ?? 'ok';
  const fallbackAnyTag = options.fallbackAnyTag ?? false;

  const projectTagIds = db
    .prepare(`SELECT tag_id FROM project_tags WHERE project_id = ?`)
    .all(projectId)
    .map((row) => (row as { tag_id: number }).tag_id);

  const baseTagId = defaultTagId(db);

  const result: MatchResult = { filled: 0, alternatives: 0, unmatched: 0 };
  if (projectTagIds.length === 0 && !fallbackAnyTag) {
    result.unmatched = ids ? ids.length : countUntranslated(db, projectId);
    return result;
  }
  if (ids && ids.length === 0) return result;

  const allowedTagIds = Array.from(new Set([...projectTagIds, baseTagId]));

  let candidatesFor: Database.Statement<unknown[], Candidate>;
  let variantsFor: Database.Statement<unknown[], Candidate>;
  if (fallbackAnyTag) {
    const projectTagOrder =
      projectTagIds.length > 0
        ? `(e.tag_id IN (${projectTagIds.map(() => '?').join(', ')})) DESC,`
        : '';
    const query =
      `SELECT e.id AS entryId, e.translation, e.translation_plural AS translationPlural
         FROM glossary_entries e
         LEFT JOIN glossary_entry_sources s ON s.entry_id = e.id
         LEFT JOIN trusted_sources t ON t.id = s.trusted_source_id
        WHERE LOOKUP = ? AND e.pos IS NULL
        GROUP BY e.id
        ORDER BY (e.origin = 'owner') DESC,
                 ${projectTagOrder}
                 (e.tag_id = ?) DESC,
                 count(DISTINCT s.trusted_source_id) DESC,
                 ifnull(min(t.rank), 2147483647) ASC,
                 e.id ASC`;
    candidatesFor = db.prepare(query.replace('LOOKUP', 'e.source_hash'));
    variantsFor = db.prepare(query.replace('LOOKUP', 'source_variant_hash(e.source_text, e.source_plural)'));
  } else {
    const placeholders = allowedTagIds.map(() => '?').join(', ');
    const projectTagOrder =
      projectTagIds.length > 0
        ? `(e.tag_id IN (${projectTagIds.map(() => '?').join(', ')})) DESC,`
        : '';
    const query =
      `SELECT e.id AS entryId, e.translation, e.translation_plural AS translationPlural
         FROM glossary_entries e
         LEFT JOIN glossary_entry_sources s ON s.entry_id = e.id
         LEFT JOIN trusted_sources t ON t.id = s.trusted_source_id
        WHERE LOOKUP = ? AND e.pos IS NULL AND e.tag_id IN (${placeholders})
        GROUP BY e.id
        ORDER BY (e.origin = 'owner') DESC,
                 ${projectTagOrder}
                 (e.tag_id = ?) DESC,
                 count(DISTINCT s.trusted_source_id) DESC,
                 ifnull(min(t.rank), 2147483647) ASC,
                 e.id ASC`;
    candidatesFor = db.prepare(query.replace('LOOKUP', 'e.source_hash'));
    variantsFor = db.prepare(query.replace('LOOKUP', 'source_variant_hash(e.source_text, e.source_plural)'));
  }

  const getCandidates = (statement: Database.Statement<unknown[], Candidate>, hash: string): Candidate[] => {
    if (fallbackAnyTag) {
      return statement.all(hash, ...projectTagIds, baseTagId);
    }
    return statement.all(hash, ...allowedTagIds, ...projectTagIds, baseTagId);
  };

  let unitQuery = `SELECT id, msgid, msgid_plural AS msgidPlural FROM translation_units WHERE project_id = ?`;
  const unitParams: unknown[] = [projectId];
  if (ids && ids.length > 0) {
    unitQuery += ` AND id IN (${ids.map(() => '?').join(', ')}) AND state <> 'ok'`;
    unitParams.push(...ids);
  } else {
    unitQuery += ` AND state = 'untranslated'`;
  }
  const units = db.prepare(unitQuery);

  const fill = db.prepare(
    `UPDATE translation_units
        SET msgstr = @translation, msgstr_plural = @translationPlural,
            state = @state, provenance = 'glossary', glossary_entry_id = @entryId,
            blocked = @blocked, updated_at = datetime('now')
      WHERE id = @id`,
  );
  const qaOverrides = db.prepare(`SELECT rule FROM qa_exceptions WHERE unit_id = ?`);

  return db.transaction((): MatchResult => {
    for (const row of units.all(...unitParams) as UnitRow[]) {
      const shape = affixes(row.msgid);
      const pluralShape = row.msgidPlural === null ? null : affixes(row.msgidPlural);
      const hash = sourceHash(shape.core, pluralShape?.core);
      let candidates = distinct(getCandidates(candidatesFor, hash));
      if (candidates.length === 0) {
        const variantHash = sourceVariantHash(shape.core, pluralShape?.core);
        if (variantHash !== null) {
          const variants = distinct(getCandidates(variantsFor, variantHash));
          // A variant can fill only when all matching entries agree on wording.
          if (variants.length === 1) candidates = variants;
        }
      }

      if (candidates.length === 0) {
        result.unmatched += 1;
        continue;
      }

      // The stored translation carries no shape; the unit's own goes back on.
      const best = candidates[0]!;
      const appliedTranslation = reapply(best.translation, shape);
      const appliedPlural =
        best.translationPlural === null || pluralShape === null
          ? best.translationPlural
          : reapply(best.translationPlural, pluralShape);

      const failures = checkTranslation({
        ordinal: 0,
        msgid: row.msgid,
        ...(row.msgidPlural ? { msgidPlural: row.msgidPlural } : {}),
        msgstr: appliedTranslation,
        ...(appliedPlural ? { msgstrPlural: appliedPlural } : {}),
      });

      let blocked = 0;
      if (failures.length > 0) {
        const overridden = new Set(
          (qaOverrides.all(row.id) as { rule: string }[]).map((r) => r.rule),
        );
        blocked = failures.some((f) => !overridden.has(f.rule)) ? 1 : 0;
      }

      fill.run({
        id: row.id,
        entryId: best.entryId,
        translation: appliedTranslation,
        translationPlural: appliedPlural,
        state: targetState,
        blocked,
      });
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

interface UnitRow {
  id: number;
  msgid: string;
  msgidPlural: string | null;
}

function countUntranslated(db: Db, projectId: number): number {
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM translation_units WHERE project_id = ? AND state = 'untranslated'`,
    )
    .get(projectId) as { n: number };
  return row.n;
}
