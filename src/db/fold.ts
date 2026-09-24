/**
 * Case-fold a string for searching, in a way that suits both columns.
 *
 * SQLite's own folding — `LIKE`, `NOCASE` — is ASCII only, so `İÇERİK` did not
 * match `içerik` while `SAVE` matched `save`. Half the glossary is English
 * sources and half is Turkish translations, and the owner searches both from
 * one box, so the fold has to serve both.
 *
 * The four i-forms are collapsed first and together: `I`, `ı`, `İ` and `i` all
 * become `i`. Turkish casing alone would send `I` to `ı`, which is right for
 * Turkish and wrong for `ITEM` — and the source column is English. Collapsing
 * them costs the distinction between `ı` and `i` in a search, which is not one
 * anybody types a query to make.
 *
 * Replacing before lowercasing also avoids `İ`.toLowerCase() producing `i` plus
 * a combining dot, which matches nothing.
 */
export function fold(value: string): string {
  return value.replace(/[Iİı]/g, 'i').toLowerCase();
}
