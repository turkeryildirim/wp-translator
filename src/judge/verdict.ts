import type { Db } from '../db/open.ts';
import { sourceHash } from '../glossary/key.ts';
import { checkTranslation } from '../quality/check.ts';

/**
 * What to do with a translation somebody else submitted.
 *
 * `exact` and `flagged` are reached without a model: the glossary already holds
 * this wording, or a quality check refuses it. `agreed` rests on the model's
 * opinion, and `unknown` means no opinion was obtained.
 */
export type Verdict = 'exact' | 'agreed' | 'flagged' | 'unknown';

/** One pending translation, as the review page presents it. */
export interface Submission {
  /** GlotPress's translation id, which is what `-set-status/` takes. */
  id: number;
  source: string;
  sourcePlural?: string;
  context?: string;
  translation: string;
  translationPlural?: string;
}

export interface Judgement {
  id: number;
  verdict: Verdict;
  /** Why, in the owner's language, ready to show beside the row. */
  reason: string;
  /** The wording the glossary or the model would have used, where it differs. */
  expected?: string;
}

/**
 * Judge a submission on the evidence that needs no model.
 *
 * Returns `null` when neither the checks nor the glossary can settle it, which
 * is the set worth paying a model for.
 */
export function judgeLocally(
  db: Db,
  submission: Submission,
  tagIds: readonly number[],
): Judgement | null {
  const failures = checkTranslation({
    ordinal: 0,
    msgid: submission.source,
    ...(submission.sourcePlural ? { msgidPlural: submission.sourcePlural } : {}),
    msgstr: submission.translation,
    ...(submission.translationPlural ? { msgstrPlural: submission.translationPlural } : {}),
  });

  if (failures.length > 0) {
    return {
      id: submission.id,
      verdict: 'flagged',
      reason: failures.map((failure) => failure.message).join(' · '),
    };
  }

  const known = glossaryWordings(db, submission, tagIds);
  if (known.length === 0) return null;

  const plural = submission.translationPlural ?? '';
  const matches = known.some(
    (entry) => entry.translation === submission.translation && (entry.plural ?? '') === plural,
  );

  return matches
    ? { id: submission.id, verdict: 'exact', reason: 'Sözlükteki karşılığın aynısı.' }
    : {
        id: submission.id,
        verdict: 'flagged',
        reason: 'Sözlük bu kaynağı başka türlü çeviriyor.',
        expected: known.map((entry) => entry.translation).join(' / '),
      };
}

/** Every translation the glossary holds for this source, under these tags. */
function glossaryWordings(
  db: Db,
  submission: Submission,
  tagIds: readonly number[],
): { translation: string; plural: string | null }[] {
  if (tagIds.length === 0) return [];

  const holes = tagIds.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT translation, translation_plural AS plural
         FROM glossary_entries
        WHERE source_hash = ? AND pos IS NULL AND tag_id IN (${holes})`,
    )
    .all(sourceHash(submission.source, submission.sourcePlural), ...tagIds) as {
    translation: string;
    plural: string | null;
  }[];
}
