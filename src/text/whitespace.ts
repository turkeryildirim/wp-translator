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
 * Every kind of whitespace, and only whitespace.
 *
 * `\s` is deliberate rather than a hand-written list: it is exactly the set the
 * quality checks compare at a string's edges, so anything folded here is still
 * guarded there. It covers the non-breaking space, the ideographic space and the
 * BOM along with the ordinary ones.
 *
 * Zero-width format characters are **not** whitespace and stay out: `\s` does
 * not match U+200B or the directional marks, and neither do the checks, so
 * folding them would hide a difference nothing else is watching. Punctuation is
 * out for the plainer reason that it changes what a string says.
 */
const LEADING = /^\s+/;
const TRAILING = /\s+$/;

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
