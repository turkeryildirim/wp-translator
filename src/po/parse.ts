import { po } from 'gettext-parser';
import type { Catalogue, TranslationUnit } from './types.ts';

/** The header entry, which gettext-parser stores as the empty msgid under the empty context. */
const HEADER_KEY = '';

/**
 * Read a PO catalogue.
 *
 * gettext-parser groups entries by context and loses the original entry order.
 * That is harmless — GlotPress matches by content, not position — but it means
 * `ordinal` is assigned here rather than recovered, and is only good for display.
 */
export function parsePo(source: Buffer | string): Catalogue {
  const parsed = po.parse(source, { defaultCharset: 'utf-8' });
  const units: TranslationUnit[] = [];

  for (const [context, entries] of Object.entries(parsed.translations)) {
    for (const [msgid, entry] of Object.entries(entries)) {
      if (context === HEADER_KEY && msgid === HEADER_KEY) continue;

      const unit: TranslationUnit = { ordinal: units.length, msgid: entry.msgid };
      if (entry.msgid_plural) unit.msgidPlural = entry.msgid_plural;
      if (context !== HEADER_KEY) unit.msgctxt = context;
      if (entry.comments?.reference) unit.refs = entry.comments.reference;
      if (entry.comments?.extracted) unit.extractedComments = entry.comments.extracted;

      const [singular, plural] = entry.msgstr;
      if (singular) unit.msgstr = singular;
      if (plural) unit.msgstrPlural = plural;

      units.push(unit);
    }
  }

  return { headers: parsed.headers, units };
}
