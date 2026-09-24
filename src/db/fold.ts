/**
 * Case-fold a string for searching.
 *
 * All four i-forms collapse to `i`, so an English source column and a Turkish
 * translation column can be searched from one box. Replacing before lowercasing
 * avoids `'İ'.toLowerCase()` producing `i` plus a combining dot.
 */
export function fold(value: string): string {
  return value.replace(/[Iİı]/g, 'i').toLowerCase();
}
