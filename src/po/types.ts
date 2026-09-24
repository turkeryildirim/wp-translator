/**
 * A single entry of a PO catalogue.
 *
 * `msgctxt` is carried verbatim from import to export and never read for
 * matching: GlotPress identifies an entry by singular + plural + context, so an
 * export that drops it loses those translations.
 */
export interface TranslationUnit {
  /** Position in the source catalogue. Kept for display; export does not depend on it. */
  ordinal: number;
  msgid: string;
  msgidPlural?: string;
  msgctxt?: string;
  /** The `#:` block, verbatim. File paths and line numbers of the call sites. */
  refs?: string;
  /** The `#.` block, verbatim. The developer's own note about the string. */
  extractedComments?: string;
  /** Singular translation, or `msgstr[0]` for a plural entry. */
  msgstr?: string;
  /** `msgstr[1]`. Turkish is `nplurals=2`, so there is at most one. */
  msgstrPlural?: string;
}

export interface Catalogue {
  headers: Record<string, string>;
  units: TranslationUnit[];
}
