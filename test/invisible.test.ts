import { describe, expect, it } from 'vitest';
import { hasInvisible, reveal } from '../panel/src/invisible.ts';

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

  it('round-trips the visible text of a clean string', () => {
    const value = 'Yorumlara izin ver';
    expect(shown(value)).toBe(value);
  });
});
