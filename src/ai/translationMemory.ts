import type { Db } from '../db/open.ts';
import { affixes, questionKey, reapply, recall, remember, rulesKey } from './memory.ts';
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
  /** The rest, worth paying a model for. */
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
      ask.push(item);
      continue;
    }

    const answer: ResponseItem = { i: item.i, t: reapply(stored.answer.t, affixes(item.s)) };
    if (stored.answer.tp && item.p) {
      answer.tp = reapply(stored.answer.tp, affixes(item.p));
    }
    known.set(item.i, answer);
  }

  return { known, ask };
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
