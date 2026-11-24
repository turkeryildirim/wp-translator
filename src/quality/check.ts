import type { TranslationUnit } from '../po/types.ts';
import { DEFAULT_BRANDS, checkBrandRules } from './brands.ts';

export type CheckRule =
  | 'empty'
  | 'printf-placeholders'
  | 'brace-placeholders'
  | 'html-tags'
  | 'plural-missing'
  | 'leading-whitespace'
  | 'trailing-whitespace'
  | 'suffix-on-placeholder'
  | 'number-plural-noun'
  | 'brand-casing'
  | 'brand-apostrophe';

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

/** Placeholder taking Turkish apostrophe suffix (e.g. %s'in, %1$s'e, {user}'ın). */
const PLACEHOLDER_SUFFIX =
  /(?:%(?:\d+\$)?(?:ll|l|z|h)?[@sdifuxXgGc]|\{[a-zA-Z_][\w.]*\}|%\([a-zA-Z_]\w*\)[sdf])['’][a-zA-ZçğıöşüÇĞİÖŞÜ\p{L}]+/gu;

/** Root words ending in -ler/-lar protected from number-plural-noun rule. */
const NUMBER_PLURAL_EXCEPTIONS = new Set([
  'dolar',
  'popüler',
  'kiler',
  'çalar',
  'modüler',
  'seküler',
  'sirküler',
  'skaler',
  'skalar',
  'polar',
  'solar',
  'molar',
  'nükleer',
  'fular',
  'radar',
  'controller',
  'handler',
  'crawler',
  'installer',
  'mailer',
  'scheduler',
  'bundler',
  'profiler',
]);

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
  checkSuffixOnPlaceholder(translation, failures);
  checkNumberPluralNoun(translation, failures);
  failures.push(...checkBrandRules(unit.msgid, translation));

  if (unit.msgidPlural && !unit.msgstrPlural) {
    failures.push({
      rule: 'plural-missing',
      message: 'The source has singular and plural forms. The translation has only one.',
    });
  }

  if (unit.msgidPlural && unit.msgstrPlural) {
    comparePrintfPlaceholders(unit.msgidPlural, unit.msgstrPlural, failures);
    comparePlaceholders(unit.msgidPlural, unit.msgstrPlural, BRACE, 'brace-placeholders', failures);
    compareTags(unit.msgidPlural, unit.msgstrPlural, failures);
    compareEdgeWhitespace(unit.msgidPlural, unit.msgstrPlural, failures);
  }

  if (unit.msgstrPlural) {
    checkSuffixOnPlaceholder(unit.msgstrPlural, failures);
    checkNumberPluralNoun(unit.msgstrPlural, failures);
    failures.push(...checkBrandRules(unit.msgidPlural ?? unit.msgid, unit.msgstrPlural));
  }

  // Deduplicate failures so plural strings or multiple rules don't produce duplicate cards
  const seen = new Set<string>();
  return failures.filter((f) => {
    const key = `${f.rule}:${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function checkSuffixOnPlaceholder(translation: string, failures: CheckFailure[]): void {
  const sanitized = translation.replace(/%%/g, '\0\0');
  const matches = sanitized.match(PLACEHOLDER_SUFFIX);
  if (!matches) return;

  for (const match of new Set(matches)) {
    failures.push({
      rule: 'suffix-on-placeholder',
      message: `Placeholders should not take suffixes with apostrophes: "${match}".`,
    });
  }
}

function checkNumberPluralNoun(translation: string, failures: CheckFailure[]): void {
  const sanitized = translation.replace(/%%/g, '\0\0');
  const pattern = /(%(?:\d+\$)?(?:ll|l|z|h)?[du])\s+(?:<[^>]+>\s*)*([a-zA-ZçğıöşüÇĞİÖŞÜ\p{L}]+)/gu;

  for (const match of sanitized.matchAll(pattern)) {
    const placeholder = match[1]!;
    const rawWord = match[2]!;
    const lowerWord = rawWord.toLocaleLowerCase('tr-TR');
    const stem = lowerWord.replace(/(?:dan|den|da|de|ın|in|un|ün|la|le|[ıieauü])$/i, '');

    if (NUMBER_PLURAL_EXCEPTIONS.has(lowerWord) || NUMBER_PLURAL_EXCEPTIONS.has(stem)) {
      continue;
    }

    if (/(?:ler|lar)(?:[ıiea]|da|de|dan|den)?$/i.test(lowerWord)) {
      failures.push({
        rule: 'number-plural-noun',
        message: `Nouns following a number placeholder must be singular: "${placeholder} ${rawWord}".`,
      });
    }
  }
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

  // 2. Token counts comparison (order- and position-independent)
  const srcTokens = src.tokens;
  const transTokens = trans.tokens;

  const srcRawCounts = new Map<string, number>();
  for (const t of srcTokens) srcRawCounts.set(t.raw, (srcRawCounts.get(t.raw) ?? 0) + 1);
  const transRawCounts = new Map<string, number>();
  for (const t of transTokens) transRawCounts.set(t.raw, (transRawCounts.get(t.raw) ?? 0) + 1);

  const rawDiffs = describeDifferences(srcRawCounts, transRawCounts);
  if (rawDiffs.length > 0) {
    // If raw tokens differ, check if it is a valid conversion between non-positional (%s, %d)
    // and positional (%1$s, %2$s) with matching argument counts and types.
    // Turkish syntax routinely moves and reorders arguments.
    const sameCount = srcTokens.length === transTokens.length;
    const srcSpecs = srcTokens.map((t) => t.spec).sort().join(',');
    const transSpecs = transTokens.map((t) => t.spec).sort().join(',');
    const validPositionalConversion = sameCount && srcSpecs === transSpecs;

    if (!validPositionalConversion) {
      differences.push(...rawDiffs);
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
