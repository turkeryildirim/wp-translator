import { describe, expect, it } from 'vitest';
import { hasInvisible, LEGEND, reveal } from '../panel/src/invisible.ts';

const shown = (value: string): string =>
  reveal(value)
    .map((segment) => segment.text)
    .join('');

describe('showing what a string is really made of', () => {
  it('leaves ordinary words exactly as they are', () => {
    expect(reveal('Sepete ekle')).toEqual([{ text: 'Sepete ekle', mark: false }]);
  });

  it('shows the example the owner asked about: newline, spaces, tab', () => {
    expect(shown('a\n   \tb')).toBe('a¶···→b');
  });

  it('shows a trailing space, which is the one that breaks an import', () => {
    expect(shown('Kaydet ')).toBe('Kaydet·');
    expect(shown(' Kaydet')).toBe('·Kaydet');
  });

  it('leaves single spaces between words unmarked', () => {
    // Marking every space turns the column into dots and hides the cases that
    // matter, which is the opposite of the point.
    expect(reveal('bir iki üç').every((segment) => !segment.mark)).toBe(true);
  });

  it('marks a run of spaces even in the middle', () => {
    expect(shown('bir  iki')).toBe('bir··iki');
  });

  it('names a character that has no glyph at all', () => {
    // Two of the owner's entries differed only by this: `%1$s %2$s` against a
    // copy carrying a leading left-to-right mark, which read as a duplicate.
    expect(shown('‎%1$s %2$s')).toBe('‹U+200E›%1$s %2$s');
  });

  it('tells a non-breaking space from a space', () => {
    expect(shown('a b')).toBe('a␣b');
    expect(shown('a b')).toBe('a b');
  });

  it('says why each marker is there', () => {
    const marks = reveal('a\tb').filter((segment) => segment.mark);
    expect(marks[0]!.title).toBe('sekme (\\t)');
  });

  it('reports whether a string hides anything', () => {
    expect(hasInvisible('Kaydet')).toBe(false);
    expect(hasInvisible('Kaydet ')).toBe(true);
    expect(hasInvisible('Kaydet​')).toBe(true);
  });

  it('never draws a marker the legend does not explain', () => {
    // The legend is the only way to know what `·` or `␍` meant. A marker that
    // reaches the screen without reaching the legend is worse than the
    // character it replaced, so both come from one table.
    const everything = ' a\tb\nc\rd\u00A0e\u200Bf\u200Eg  h ';
    const drawn = reveal(everything).filter((segment) => segment.mark);
    expect(drawn.length).toBeGreaterThan(6);

    for (const segment of drawn) {
      const explained = LEGEND.some(
        (marker) =>
          segment.text === marker.text ||
          // A run of spaces is that marker repeated; a nameless character
          // carries its own codepoint in place of the ellipsis.
          (marker.text === '·' && /^·+$/.test(segment.text)) ||
          (marker.text === '‹U+…›' && /^‹U\+[0-9A-F]{4,6}›$/.test(segment.text)),
      );
      expect(explained, `legend explains ${JSON.stringify(segment.text)}`).toBe(true);
    }
  });

  it('gives each legend entry a distinct marker', () => {
    expect(new Set(LEGEND.map((marker) => marker.text)).size).toBe(LEGEND.length);
  });

  it('names every whitespace character the owner asked about', () => {
    expect(LEGEND.map((marker) => marker.note)).toEqual(
      expect.arrayContaining(['\\t', '\\n', '\\r', 'U+00A0']),
    );
  });

  it('round-trips the visible text of a clean string', () => {
    const value = 'Yorumlara izin ver';
    expect(shown(value)).toBe(value);
  });
});
