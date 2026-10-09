import type { Db } from '../db/open.ts';
import { affixes, questionKey, reapply, recall, remember, rulesKey } from './memory.ts';
import { unescapeEchoedQuotes } from '../text/escapes.ts';
import type { RequestItem, ResponseItem } from '../translate/types.ts';

/** What the store holds for one source: the translation, without its shape. */
interface Stored {
  t: string;
  tp?: string;
}

const keyOf = (item: RequestItem): string => questionKey([item.s, item.p ?? '']);

export interface Split {
  /** Answers the store already had, shaped to the strings that asked for them. */
  known: Map<number, ResponseItem>;
  /**
   * The rest, worth paying a model for — with their surrounding whitespace
   * stripped. The model is asked what the words mean, not what shape they came
   * in, and `reshape` puts the shape back on the answer.
   */
  ask: RequestItem[];
}

/**
 * Take out of a batch whatever the model has already answered under these rules.
 *
 * The stored answer is the bare translation; the surrounding whitespace comes
 * from the string being answered now, so `Save` and `  Save ` share one entry
 * and each still gets its own shape back.
 */
export function splitByMemory(
  db: Db,
  items: readonly RequestItem[],
  styleGuide: string,
): Split {
  const rules = rulesKey(styleGuide);
  const known = new Map<number, ResponseItem>();
  const ask: RequestItem[] = [];

  for (const item of items) {
    const stored = recall<Stored>(db, 'translation', keyOf(item), rules);
    if (!stored) {
      ask.push({
        ...item,
        s: affixes(item.s).core,
        ...(item.p ? { p: affixes(item.p).core } : {}),
      });
      continue;
    }

    // Repaired on the way out rather than on the way in: an answer stored
    // before the repair existed is still in here, and reading it is what the
    // owner hits — memory is never asked again, so a wording the checks refuse
    // would be refused for ever.
    const answer: ResponseItem = {
      i: item.i,
      t: reapply(unescapeEchoedQuotes(item.s, stored.answer.t), affixes(item.s)),
    };
    if (stored.answer.tp && item.p) {
      answer.tp = reapply(unescapeEchoedQuotes(item.p, stored.answer.tp), affixes(item.p));
    }
    known.set(item.i, answer);
  }

  return { known, ask };
}

/**
 * Put each source's surrounding whitespace back onto the answer given for it.
 *
 * The model was asked without it, so the answer comes back without it, and the
 * shape belongs to the string being translated rather than to the question.
 */
export function reshape(
  original: readonly RequestItem[],
  answers: readonly ResponseItem[],
): ResponseItem[] {
  const byId = new Map(original.map((item) => [item.i, item]));

  return answers.map((answer) => {
    const item = byId.get(answer.i);
    if (!item) return answer;

    const shaped: ResponseItem = { i: answer.i, t: reapply(answer.t, affixes(item.s)) };
    if (answer.tp && item.p) shaped.tp = reapply(answer.tp, affixes(item.p));
    else if (answer.tp) shaped.tp = answer.tp;
    return shaped;
  });
}

/** Keep what the model just said, stripped of the shape it was asked in. */
export function rememberTranslations(
  db: Db,
  asked: readonly RequestItem[],
  answers: readonly ResponseItem[],
  styleGuide: string,
  model: string | null,
): void {
  const rules = rulesKey(styleGuide);
  const byId = new Map(asked.map((item) => [item.i, item]));

  db.transaction(() => {
    for (const answer of answers) {
      const item = byId.get(answer.i);
      if (!item) continue;

      const stored: Stored = { t: affixes(answer.t).core };
      if (answer.tp) stored.tp = affixes(answer.tp).core;
      if (!stored.t) continue;

      remember(db, {
        kind: 'translation',
        keyHash: keyOf(item),
        rulesHash: rules,
        sourceText: affixes(item.s).core,
        question: { source: affixes(item.s).core, ...(item.p ? { plural: affixes(item.p).core } : {}) },
        answer: stored,
        model,
      });
    }
  })();
}
