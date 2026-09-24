import { createHash } from 'node:crypto';

/** Separates singular from plural so `("a\u001fb", "")` cannot collide with `("a", "b")`. */
const FIELD_SEPARATOR = '\u001f';

/**
 * The glossary's lookup key for a source string.
 *
 * Hashing rather than indexing the text keeps the unique index compact —
 * WooCommerce source strings run to several hundred characters — and matching is
 * byte-exact by design, so there is nothing to normalise first.
 */
export function sourceHash(msgid: string, msgidPlural?: string): string {
  return createHash('sha256')
    .update(msgid + FIELD_SEPARATOR + (msgidPlural ?? ''))
    .digest('hex');
}
