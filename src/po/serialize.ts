import { po } from 'gettext-parser';
import type { Catalogue, TranslationUnit } from './types.ts';

/**
 * Write a PO catalogue.
 *
 * Writes exactly the units it is given. Deciding *which* units are exportable
 * belongs to the export step, not here — GlotPress silently drops an entry with
 * an empty `msgstr`, reads `#, fuzzy` as fuzzy status and ignores `#~` obsolete
 * entries, so the caller filters to approved translations first.
 */
export function serializePo(catalogue: Catalogue): Buffer {
  const translations: Record<string, Record<string, Record<string, unknown>>> = {};

  for (const unit of catalogue.units) {
    const context = unit.msgctxt ?? '';
    const group = (translations[context] ??= {});
    group[unit.msgid] = toGettextEntry(unit);
  }

  // gettext-parser expects the header as the empty msgid under the empty context.
  (translations[''] ??= {})[''] = { msgid: '', msgstr: [headerBlock(catalogue.headers)] };

  return po.compile(
    { headers: catalogue.headers, translations } as never,
    { foldLength: 0 },
  );
}

function toGettextEntry(unit: TranslationUnit): Record<string, unknown> {
  const comments: Record<string, string> = {};
  if (unit.refs) comments.reference = unit.refs;
  if (unit.extractedComments) comments.extracted = unit.extractedComments;

  const entry: Record<string, unknown> = {
    msgid: unit.msgid,
    msgstr: unit.msgidPlural
      ? [unit.msgstr ?? '', unit.msgstrPlural ?? '']
      : [unit.msgstr ?? ''],
  };
  if (unit.msgidPlural) entry.msgid_plural = unit.msgidPlural;
  if (unit.msgctxt) entry.msgctxt = unit.msgctxt;
  if (Object.keys(comments).length > 0) entry.comments = comments;

  return entry;
}

function headerBlock(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}\n`)
    .join('');
}
