/**
 * Take back off the JSON escaping a model copied out of its own payload.
 *
 * The strings ride to the model inside `JSON.stringify`, where a quote is
 * spelled `\"`, and a model sometimes reproduces that spelling in the answer —
 * the quote arrives with a backslash in front of it. `href=\"…\"` is not the
 * attribute the source carries, so the HTML check refuses the wording, and the
 * refusal reads as a tag the translation dropped.
 */

/** A quote the model handed back still wearing its escape. */
const ESCAPED_QUOTE = /\\+"/g;

/**
 * Undo that one echo, and nothing else.
 *
 * Narrow on purpose: a source that carries a backslash of its own means it —
 * `WordPress\AI\log_ai_request()`, `\frac{a}{b}` — and there the model's
 * backslashes are the translation, not damage. Quotes alone are repaired, because
 * `\"` is the echo that reaches the quality checks as damage.
 */
export function unescapeEchoedQuotes(source: string, wording: string): string {
  if (source.includes('\\') || !wording.includes('\\"')) return wording;
  return wording.replace(ESCAPED_QUOTE, '"');
}
