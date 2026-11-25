import { createHash } from 'node:crypto';

/** Separates singular from plural so `("a\u001fb", "")` cannot collide with `("a", "b")`. */
const FIELD_SEPARATOR = '\u001f';

/**
 * The glossary's lookup key for a source string.
 *
 * Hashing rather than indexing the text keeps the unique index compact —
 * WooCommerce source strings run to several hundred characters — and matching is
 * byte-exact, so distinct source variants retain their own identity.
 */
export function sourceHash(msgid: string, msgidPlural?: string): string {
  return createHash('sha256')
    .update(msgid + FIELD_SEPARATOR + (msgidPlural ?? ''))
    .digest('hex');
}

// Only the supported surrounding marks are removed. Technical characters such
// as #, _, / and & and all interior characters retain their meaning.
const EDGE_MARKS = /^[\s.,:!?…\p{Pd}−()[\]'"`‘’‚‛“”„‟«»‹›]+|[\s.,:!?…\p{Pd}−()[\]'"`‘’‚‛“”„‟«»‹›]+$/gu;

export function variantText(text: string): string {
  return text.replace(EDGE_MARKS, '').toLowerCase();
}

/** A separate lookup key; it never replaces the source's exact identity. */
export function sourceVariantHash(msgid: string, msgidPlural?: string | null): string | null {
  const singular = variantText(msgid);
  const plural = msgidPlural == null ? '' : variantText(msgidPlural);
  if (!singular || (msgidPlural != null && !plural)) return null;
  return sourceHash(singular, plural);
}
