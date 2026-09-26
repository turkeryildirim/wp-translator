/**
 * Plain whitespace, factored out and put back.
 *
 * A string's surrounding whitespace is shape, not meaning: the rule everywhere
 * here is to keep the source's, so it can be taken off a question and restored
 * to the answer. Nothing else is folded — punctuation, the non-breaking space,
 * the BOM and the directional marks all keep strings apart.
 */
export interface Affixes {
  lead: string;
  core: string;
  trail: string;
}

/**
 * Plain whitespace, and nothing else.
 *
 * Deliberately not `trim()`, which also strips the non-breaking space, the BOM
 * and the ideographic space. Those are characters this tool marks as distinct
 * when it reveals what a string contains, so folding them here would have it
 * contradicting itself. Punctuation is out of scope too: `Hello.` and `Hello`
 * are different strings and stay different questions.
 */
const LEADING = /^[ \t\n\r\v\f]+/;
const TRAILING = /[ \t\n\r\v\f]+$/;

/**
 * Split a string into its surrounding whitespace and what it says.
 *
 * `Save` and `Save ` are the same translation problem in a different shape, so
 * they share one answer; the shape goes back on afterwards.
 *
 * Safe because the affixes are mechanical: the rule is to keep the source's, and
 * a translation that fails to is caught by `checkTranslation` before anything is
 * asked of the model.
 */
export function affixes(text: string): Affixes {
  const lead = LEADING.exec(text)?.[0] ?? '';
  const withoutLead = text.slice(lead.length);
  const trail = TRAILING.exec(withoutLead)?.[0] ?? '';
  const core = withoutLead.slice(0, withoutLead.length - trail.length);

  // All whitespace: there is no core, so the whole string is its own shape.
  return core === '' ? { lead: '', core: '', trail: text } : { lead, core, trail };
}

/** Put a source's surrounding whitespace back onto an answer given for its core. */
export const reapply = (core: string, shape: Affixes): string =>
  core === '' ? core : shape.lead + core + shape.trail;
