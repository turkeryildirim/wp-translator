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
  /**
   * One wording the owner can apply to the row unchanged, where there is one.
   * Separate from `expected`, which is for reading and may name several.
   */
  proposal?: string;
}

/**
 * A wording safe to offer for a single click, or nothing.
 *
 * Whatever is applied to a row this way has never been reviewed, so it passes
 * the same checks as a translation of the tool's own. A plural source needs
 * every form and one wording is not — `checkTranslation` reports that too.
 */
export function proposalFor(
  submission: Submission,
  wording: string,
  wordingPlural?: string,
): string | undefined {
  if (!wording.trim()) return undefined;

  const failures = checkTranslation({
    ordinal: 0,
    msgid: submission.source,
    ...(submission.sourcePlural ? { msgidPlural: submission.sourcePlural } : {}),
    msgstr: wording,
    ...(wordingPlural ? { msgstrPlural: wordingPlural } : {}),
  });

  return failures.length === 0 ? wording : undefined;
}

/** Why the checks refuse a wording, in one line, or null when they do not. */
export function refusalFor(
  submission: Submission,
  wording: string,
  wordingPlural?: string,
): string | null {
  const failures = checkTranslation({
    ordinal: 0,
    msgid: submission.source,
    ...(submission.sourcePlural ? { msgidPlural: submission.sourcePlural } : {}),
    msgstr: wording,
    ...(wordingPlural ? { msgstrPlural: wordingPlural } : {}),
  });

  return failures.length === 0 ? null : failures.map((failure) => failure.message).join(' · ');
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
  const plural = submission.translationPlural ?? '';

  if (known.length > 0) {
    const matches = known.some(
      (entry) => entry.translation === submission.translation && (entry.plural ?? '') === plural,
    );
    if (matches) {
      return { id: submission.id, verdict: 'exact', reason: 'Sözlükteki karşılığın aynısı.' };
    }
  }

  // Check if translation matches a valid wording across any tag in translation memory
  const allWordings = db
    .prepare(
      `SELECT translation, translation_plural AS plural
         FROM glossary_entries
        WHERE source_hash = ? AND pos IS NULL`,
    )
    .all(sourceHash(submission.source, submission.sourcePlural)) as {
    translation: string;
    plural: string | null;
  }[];

  if (allWordings.length > 0) {
    const matchesAny = allWordings.some(
      (entry) => entry.translation === submission.translation && (entry.plural ?? '') === plural,
    );
    if (matchesAny) {
      return { id: submission.id, verdict: 'exact', reason: 'Sözlükteki karşılığın aynısı.' };
    }
  }

  if (known.length === 0) return null;

  // Offered for one click only when the glossary is unambiguous: a list of
  // wordings is not a wording.
  const proposal = known.length === 1 ? proposalFor(submission, known[0]!.translation) : undefined;

  return {
    id: submission.id,
    verdict: 'flagged',
    reason: 'Sözlük bu kaynağı başka türlü çeviriyor.',
    expected: known.map((entry) => entry.translation).join(' / '),
    ...(proposal ? { proposal } : {}),
  };
}

/** Every translation the glossary holds for this source, under these tags. */
export function glossaryWordings(
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
