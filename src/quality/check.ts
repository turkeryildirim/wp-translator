import type { TranslationUnit } from '../po/types.ts';

export type CheckRule =
  | 'empty'
  | 'printf-placeholders'
  | 'brace-placeholders'
  | 'html-tags'
  | 'plural-missing'
  | 'leading-whitespace'
  | 'trailing-whitespace';

export interface CheckFailure {
  rule: CheckRule;
  /**
   * Plain language, stating what differs rather than naming a rule. The owner
   * reads this while deciding whether to override, so "source has %1$s and %2$s,
   * translation has only %1$s" is worth more than a rule code.
   *
   * English for now; the interface language is undecided (O20).
   */
  message: string;
}

/**
 * `%s`, `%d`, `%1$s`, `%%` from PHP and JavaScript, plus the forms the mobile
 * apps use: `%@` and `%1$@` on iOS, and length modifiers such as `%ld`.
 *
 * `%@` matters more than it looks — the iOS catalogue carries 313 of them, so a
 * pattern without it reports that catalogue as clean while ignoring its most
 * common placeholder.
 */
const PRINTF = /%(?:\d+\$)?(?:ll|l|z|h)?[@sdifuxXgGc]|%%/g;
/** `{count}`, `%(name)s` — common in JavaScript-side and Python-influenced strings. */
const BRACE = /\{[a-zA-Z_][\w.]*\}|%\([a-zA-Z_]\w*\)[sdf]/g;
/** Opening, closing and self-closing tags. */
const HTML_TAG = /<\/?[a-zA-Z][^<>]*>/g;

/**
 * Attributes whose *value* is text the reader sees, so translating it is correct.
 *
 * Comparing these by value reports every properly translated tooltip as damage.
 * Their presence is still compared: dropping the attribute is a real loss, and
 * `href` and the rest are compared in full because a placeholder inside one must
 * survive exactly.
 */
const TRANSLATABLE_ATTRIBUTES = new Set(['title', 'alt', 'aria-label', 'placeholder']);

const ATTRIBUTE = /([a-zA-Z_:][-\w:.]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/g;

/**
 * Check a translation against its source.
 *
 * These are blocking (D9): a unit that fails cannot be approved without an
 * explicit, recorded override. They only reach the minority of strings that
 * carry technical structure — 51–92 % of a project has none, and for those this
 * returns nothing because there is nothing malformed to find (R20).
 */
export function checkTranslation(unit: TranslationUnit): CheckFailure[] {
  const failures: CheckFailure[] = [];
  const translation = unit.msgstr;

  if (!translation) {
    return [{ rule: 'empty', message: 'The translation is empty.' }];
  }

  comparePlaceholders(unit.msgid, translation, PRINTF, 'printf-placeholders', failures);
  comparePlaceholders(unit.msgid, translation, BRACE, 'brace-placeholders', failures);
  compareTags(unit.msgid, translation, failures);
  compareEdgeWhitespace(unit.msgid, translation, failures);

  if (unit.msgidPlural && !unit.msgstrPlural) {
    failures.push({
      rule: 'plural-missing',
      message: 'The source has singular and plural forms. The translation has only one.',
    });
  }

  return failures;
}

function comparePlaceholders(
  source: string,
  translation: string,
  pattern: RegExp,
  rule: CheckRule,
  failures: CheckFailure[],
): void {
  const inSource = countMatches(source, pattern);
  const inTranslation = countMatches(translation, pattern);
  const differences = describeDifferences(inSource, inTranslation);
  if (differences.length === 0) return;

  failures.push({
    rule,
    message: `Placeholders differ: ${differences.join('; ')}.`,
  });
}

function compareTags(source: string, translation: string, failures: CheckFailure[]): void {
  const inSource = countTags(source);
  const inTranslation = countTags(translation);
  const differences = describeDifferences(inSource, inTranslation);
  if (differences.length === 0) return;

  failures.push({ rule: 'html-tags', message: `HTML differs: ${differences.join('; ')}.` });
}

/** Tags keyed by name and attributes, with translatable attribute values blanked. */
function countTags(text: string): Map<string, number> {
  const counts = new Map<string, number>();

  for (const [tag] of text.matchAll(new RegExp(HTML_TAG.source, HTML_TAG.flags))) {
    const key = normaliseTag(tag);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function normaliseTag(tag: string): string {
  return tag.replace(new RegExp(ATTRIBUTE.source, ATTRIBUTE.flags), (whole, name: string) =>
    TRANSLATABLE_ATTRIBUTES.has(name.toLowerCase()) ? `${name}="…"` : whole,
  );
}

function compareEdgeWhitespace(
  source: string,
  translation: string,
  failures: CheckFailure[],
): void {
  // A trailing space before a value is usually deliberate, and matching is
  // byte-exact, so losing it changes the string (R13).
  const leading = (text: string) => /^\s*/.exec(text)![0];
  const trailing = (text: string) => /\s*$/.exec(text)![0];

  if (leading(source) !== leading(translation)) {
    failures.push({
      rule: 'leading-whitespace',
      message: 'The leading whitespace differs from the source.',
    });
  }
  if (trailing(source) !== trailing(translation)) {
    failures.push({
      rule: 'trailing-whitespace',
      message: 'The trailing whitespace differs from the source.',
    });
  }
}

/**
 * Tokens counted by identity, never by position.
 *
 * Turkish word order routinely moves placeholders and the tags around them —
 * that is what `%1$s` exists for — so order is not compared. A changed *count*
 * still is: dropping or duplicating a tag is damage, moving one is translation.
 */
function countMatches(text: string, pattern: RegExp): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [match] of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
    counts.set(match, (counts.get(match) ?? 0) + 1);
  }
  return counts;
}

function describeDifferences(
  source: Map<string, number>,
  translation: Map<string, number>,
): string[] {
  const differences: string[] = [];
  for (const token of new Set([...source.keys(), ...translation.keys()])) {
    const inSource = source.get(token) ?? 0;
    const inTranslation = translation.get(token) ?? 0;
    if (inSource === inTranslation) continue;

    if (inTranslation === 0) differences.push(`the source has ${token}, the translation has none`);
    else if (inSource === 0) differences.push(`the translation has ${token}, the source has none`);
    else differences.push(`${token} appears ${inSource}× in the source and ${inTranslation}× in the translation`);
  }
  return differences;
}
