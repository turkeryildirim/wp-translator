import { unescapeEchoedQuotes } from '../text/escapes.ts';

const LEADING = /^\s+/;
const TRAILING = /\s+$/;

export interface EdgeWhitespace {
  lead: string;
  trail: string;
  core: string;
}

export function extractEdges(text: string): EdgeWhitespace {
  const lead = LEADING.exec(text)?.[0] ?? '';
  const withoutLead = text.slice(lead.length);
  const trail = TRAILING.exec(withoutLead)?.[0] ?? '';
  const core = withoutLead.slice(0, withoutLead.length - trail.length);
  return { lead, trail, core };
}

/**
 * Mechanically repairs deterministic defects that require no LLM judgement:
 * 1. Matches source's leading and trailing whitespace.
 * 2. Removes extraneous JSON/echoed escape backslashes on quotes.
 *
 * Returns undefined if no mechanical change was needed.
 */
export function repairMechanically(source: string, translation: string): string | undefined {
  if (translation.trim() === '') return undefined;

  const srcEdges = extractEdges(source);
  const transEdges = extractEdges(translation);
  const unescapedCore = unescapeEchoedQuotes(source, transEdges.core);

  // If whitespace already matches and escaping did not change, nothing to repair
  if (
    transEdges.lead === srcEdges.lead &&
    transEdges.trail === srcEdges.trail &&
    unescapedCore === transEdges.core
  ) {
    return undefined;
  }

  return `${srcEdges.lead}${unescapedCore}${srcEdges.trail}`;
}

/**
 * Mechanically repairs both singular and optional plural forms for a unit.
 */
export function repairTranslationUnit(
  source: string,
  translation: string,
  sourcePlural?: string,
  translationPlural?: string,
): { translation: string; translationPlural?: string; repaired: boolean } {
  const repMain = repairMechanically(source, translation);
  const repPlural =
    sourcePlural && translationPlural ? repairMechanically(sourcePlural, translationPlural) : undefined;

  const repaired = repMain !== undefined || repPlural !== undefined;
  return {
    translation: repMain ?? translation,
    ...(translationPlural !== undefined ? { translationPlural: repPlural ?? translationPlural } : {}),
    repaired,
  };
}
