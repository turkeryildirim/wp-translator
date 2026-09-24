import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsePo } from '../src/po/parse.ts';
import { serializePo } from '../src/po/serialize.ts';
import type { TranslationUnit } from '../src/po/types.ts';

const fixture = (name: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));

/** Identity of an entry as GlotPress sees it: singular + plural + context. */
const identity = (unit: TranslationUnit) =>
  `${unit.msgctxt ?? ''}\u0004${unit.msgid}\u0004${unit.msgidPlural ?? ''}`;

const roundTrip = (name: string) => {
  const original = parsePo(fixture(name));
  const reparsed = parsePo(serializePo(original));
  return { original, reparsed };
};

describe('PO round trip', () => {
  it.each(['classic-editor.po', 'edge-cases.po'])('preserves every entry of %s', (name) => {
    const { original, reparsed } = roundTrip(name);

    expect(reparsed.units).toHaveLength(original.units.length);
    expect(new Set(reparsed.units.map(identity))).toEqual(
      new Set(original.units.map(identity)),
    );
  });

  it.each(['classic-editor.po', 'edge-cases.po'])(
    'preserves context, references, comments and translations of %s',
    (name) => {
      const { original, reparsed } = roundTrip(name);
      const after = new Map(reparsed.units.map((u) => [identity(u), u]));

      for (const before of original.units) {
        const now = after.get(identity(before));
        expect(now, `entry missing after round trip: ${identity(before)}`).toBeDefined();
        expect(now!.msgctxt).toBe(before.msgctxt);
        expect(now!.msgstr).toBe(before.msgstr);
        expect(now!.msgstrPlural).toBe(before.msgstrPlural);
        expect(now!.refs).toBe(before.refs);
        expect(now!.extractedComments).toBe(before.extractedComments);
      }
    },
  );

  it('keeps the two entries whose msgid is the string "0"', () => {
    // A truthiness check drops these, because "0" is falsy — which is how a
    // truthiness check discards the entry. This asserts we never regress into it.
    const { reparsed } = roundTrip('edge-cases.po');
    const zeros = reparsed.units.filter((u) => u.msgid === '0');

    expect(zeros).toHaveLength(2);
    expect(zeros.map((u) => u.msgctxt ?? '')).toEqual(expect.arrayContaining(['', 'maxlength']));
  });

  it('keeps plural forms intact', () => {
    const { reparsed } = roundTrip('edge-cases.po');
    const plural = reparsed.units.find((u) => u.msgidPlural);

    expect(plural?.msgidPlural).toBe('%1$s items in %2$s');
    expect(plural?.msgstr).toBe('%2$s içinde %1$s öge');
    expect(plural?.msgstrPlural).toBe('%2$s içinde %1$s öge');
  });

  it('keeps significant trailing whitespace', () => {
    // Matching is byte-exact (R13), so a trimmed source silently stops matching.
    const { reparsed } = roundTrip('edge-cases.po');
    expect(reparsed.units.find((u) => u.msgid === 'SKU: ')?.msgstr).toBe('Stok kodu: ');
  });

  it('emits nothing GlotPress would drop or mis-flag', () => {
    const written = serializePo(parsePo(fixture('edge-cases.po'))).toString('utf-8');

    expect(written).not.toMatch(/^#, .*fuzzy/m);
    expect(written).not.toMatch(/^#~/m);
  });

  it('preserves the Plural-Forms header', () => {
    // gettext-parser keeps the original header casing, so the key is `Plural-Forms`.
    const { reparsed } = roundTrip('edge-cases.po');
    expect(reparsed.headers['Plural-Forms']).toBe('nplurals=2; plural=n > 1;');
  });

  it('lowercases only the header charset, which is case-insensitive', () => {
    // The one mutation gettext-parser makes (ADR-0001). Asserted so a future
    // version changing behaviour is caught rather than discovered in GlotPress.
    const written = serializePo(parsePo(fixture('edge-cases.po'))).toString('utf-8');
    expect(written).toContain('charset=utf-8');
  });
});
