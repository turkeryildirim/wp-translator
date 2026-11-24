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
  /** Plain language, stating what differs rather than naming a rule. */
  message: string;
}

/**
 * Printf argument token (excluding literal %%), e.g. `%s`, `%d`, `%1$s`, `%@`, `%ld`.
 */
const PRINTF_TOKEN = /%(?:(?<pos>\d+)\$)?(?:ll|l|z|h)?(?<spec>[@sdifuxXgGc])/g;

/** `{count}`, `%(name)s` — common in JavaScript-side and Python-influenced strings. */
const BRACE = /\{[a-zA-Z_][\w.]*\}|%\([a-zA-Z_]\w*\)[sdf]/g;

/** Opening, closing and self-closing tags. */
const HTML_TAG = /<\/?[a-zA-Z][^<>]*>/g;

/**
 * Attributes whose *value* is text the reader sees, so translating it is correct.
 * Their presence is still compared; every other attribute is compared in full,
 * because a placeholder inside one must survive exactly.
 */
const TRANSLATABLE_ATTRIBUTES = new Set([
  'title',
  'alt',
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'placeholder',
  'label',
  'data-title',
  'data-tooltip',
]);

const ATTRIBUTE = /([a-zA-Z_:][-\w:.]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/g;

/**
 * Check a translation against its source.
 *
 * Failures are blocking: a unit cannot be approved without a recorded override.
 * Only strings carrying technical structure can fail; for plain prose this
 * returns nothing, because there is nothing malformed to find.
 */
export function checkTranslation(unit: TranslationUnit): CheckFailure[] {
  const failures: CheckFailure[] = [];
  const translation = unit.msgstr;

  if (!translation) {
    return [{ rule: 'empty', message: 'The translation is empty.' }];
  }

  comparePrintfPlaceholders(unit.msgid, translation, failures);
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

interface PrintfToken {
  raw: string;
  pos: number;
  spec: string;
}

function extractPrintfPlaceholders(text: string): { tokens: PrintfToken[]; percentCount: number } {
  const percentMatches = text.match(/%%/g);
  const percentCount = percentMatches ? percentMatches.length : 0;
  const sanitized = text.replace(/%%/g, '\0\0');

  const tokens: PrintfToken[] = [];
  let implicitIndex = 1;

  for (const m of sanitized.matchAll(new RegExp(PRINTF_TOKEN.source, PRINTF_TOKEN.flags))) {
    const raw = m[0];
    const posStr = m.groups?.pos;
    const spec = m.groups?.spec ?? '';
    const pos = posStr ? parseInt(posStr, 10) : implicitIndex++;
    tokens.push({ raw, pos, spec });
  }

  return { tokens, percentCount };
}

function comparePrintfPlaceholders(
  source: string,
  translation: string,
  failures: CheckFailure[],
): void {
  const src = extractPrintfPlaceholders(source);
  const trans = extractPrintfPlaceholders(translation);
  const differences: string[] = [];

  // 1. Literal %% comparison
  if (src.percentCount !== trans.percentCount) {
    if (trans.percentCount === 0) differences.push('the source has %%, the translation has none');
    else if (src.percentCount === 0) differences.push('the translation has %%, the source has none');
    else differences.push(`%% appears ${src.percentCount}× in the source and ${trans.percentCount}× in the translation`);
  }

  // 2. Token counts and argument mapping
  const srcTokens = src.tokens;
  const transTokens = trans.tokens;

  const srcRawCounts = new Map<string, number>();
  for (const t of srcTokens) srcRawCounts.set(t.raw, (srcRawCounts.get(t.raw) ?? 0) + 1);
  const transRawCounts = new Map<string, number>();
  for (const t of transTokens) transRawCounts.set(t.raw, (transRawCounts.get(t.raw) ?? 0) + 1);

  if (srcTokens.length !== transTokens.length) {
    const diffTokens = describeDifferences(srcRawCounts, transRawCounts);
    if (diffTokens.length > 0) {
      differences.push(...diffTokens);
    } else {
      differences.push(`source has ${srcTokens.length} placeholders, translation has ${transTokens.length}`);
    }
  } else if (srcTokens.length > 0) {
    // Both have the same number of placeholders.
    // Check if translation is a valid reordering/mapping of source arguments.
    const srcArgSpecs = new Map<number, string>();
    for (let i = 0; i < srcTokens.length; i++) {
      srcArgSpecs.set(i + 1, srcTokens[i]!.spec);
    }

    const transPosCounts = new Map<number, number>();
    for (const t of transTokens) {
      transPosCounts.set(t.pos, (transPosCounts.get(t.pos) ?? 0) + 1);
    }

    let semanticValid = true;
    for (let pos = 1; pos <= srcTokens.length; pos++) {
      const count = transPosCounts.get(pos) ?? 0;
      if (count !== 1) {
        semanticValid = false;
        break;
      }
      const transTok = transTokens.find((t) => t.pos === pos);
      if (!transTok || transTok.spec !== srcArgSpecs.get(pos)) {
        semanticValid = false;
        break;
      }
    }

    if (!semanticValid) {
      const diffTokens = describeDifferences(srcRawCounts, transRawCounts);
      if (diffTokens.length > 0) {
        differences.push(...diffTokens);
      } else {
        differences.push('placeholder positions or types do not match source');
      }
    }
  }

  if (differences.length > 0) {
    failures.push({
      rule: 'printf-placeholders',
      message: `Placeholders differ: ${differences.join('; ')}.`,
    });
  }
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
  const isInput = /^<input\b/i.test(tag);
  const isSubmitOrButton = isInput && /type=["']?(submit|button|reset)["']?/i.test(tag);
  const isButton = /^<button\b/i.test(tag);

  return tag.replace(new RegExp(ATTRIBUTE.source, ATTRIBUTE.flags), (whole, name: string) => {
    const lower = name.toLowerCase();
    if (lower === 'value') {
      if (isSubmitOrButton || isButton) {
        return `${name}="…"`;
      }
      return whole;
    }
    return TRANSLATABLE_ATTRIBUTES.has(lower) ? `${name}="…"` : whole;
  });
}

function compareEdgeWhitespace(
  source: string,
  translation: string,
  failures: CheckFailure[],
): void {
  // A trailing space before a value is usually deliberate, and matching is
  // byte-exact, so losing it changes the string.
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
