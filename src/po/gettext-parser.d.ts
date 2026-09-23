/**
 * Narrow declarations for the part of `gettext-parser` this project uses.
 * The package ships no types and `@types/gettext-parser` does not exist.
 */
declare module 'gettext-parser' {
  interface GettextComments {
    translator?: string;
    reference?: string;
    extracted?: string;
    flag?: string;
    previous?: string;
  }

  interface GettextTranslation {
    msgid: string;
    msgid_plural?: string;
    msgctxt?: string;
    msgstr: string[];
    comments?: GettextComments;
  }

  interface GettextCatalogue {
    charset?: string;
    headers: Record<string, string>;
    /** Keyed by msgctxt (`''` for none), then by msgid. */
    translations: Record<string, Record<string, GettextTranslation>>;
  }

  export const po: {
    parse(buffer: Buffer | string, options?: { defaultCharset?: string }): GettextCatalogue;
    compile(catalogue: GettextCatalogue, options?: { foldLength?: number; sort?: boolean }): Buffer;
  };
}
