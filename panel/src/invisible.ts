export interface Segment {
  text: string;
  /** True when this stands in for characters that have no appearance. */
  mark: boolean;
  /** What the marker stands for, for a tooltip. */
  title?: string;
}

const GLYPH: Record<string, { text: string; title: string }> = {
  '\n': { text: '¶', title: 'satır sonu (\\n)' },
  '\r': { text: '␍', title: 'satır başı (\\r)' },
  '\t': { text: '→', title: 'sekme (\\t)' },
  ' ': { text: '␣', title: 'bölünmez boşluk (U+00A0)' },
};

/**
 * Anything else with no appearance: format characters, the other space
 * separators, line and paragraph separators, and C0/C1 controls. These are
 * named by codepoint rather than given a glyph, because there is no convention
 * for them and a wrong guess reads as ordinary text.
 */
const NAMELESS = /[\p{Cf}\p{Zs}\p{Zl}\p{Zp}\p{Cc}]/u;

/**
 * Split a string so a reader can see what is in it.
 *
 * A translation is judged against its source character by character, and the
 * characters most likely to be wrong are the ones neither string shows: a
 * trailing space, a tab that became spaces, a `\n` that went missing. One of
 * the owner's own entries differed from another only by a leading U+200E, which
 * made two rows look like duplicates of each other.
 *
 * Single spaces between words are left alone. Marking every one of them turns
 * the column into dots and hides the cases that matter, which is the opposite
 * of the point; a space is only shown when it leads, trails, or comes in a run.
 */
export function reveal(value: string): Segment[] {
  const segments: Segment[] = [];
  let plain = '';

  const flush = (): void => {
    if (plain) segments.push({ text: plain, mark: false });
    plain = '';
  };

  for (let at = 0; at < value.length; at += 1) {
    const character = value[at]!;

    if (character === ' ') {
      let end = at;
      while (value[end] === ' ') end += 1;
      const run = end - at;

      if (run > 1 || at === 0 || end === value.length) {
        flush();
        segments.push({ text: '·'.repeat(run), mark: true, title: `${run} boşluk` });
      } else {
        plain += ' ';
      }
      at = end - 1;
      continue;
    }

    const glyph = GLYPH[character];
    if (glyph) {
      flush();
      segments.push({ text: glyph.text, mark: true, title: glyph.title });
      continue;
    }

    if (NAMELESS.test(character)) {
      flush();
      const code = character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
      segments.push({ text: `‹U+${code}›`, mark: true, title: `görünmez karakter U+${code}` });
      continue;
    }

    plain += character;
  }

  flush();
  return segments;
}

/** True when the string carries anything `reveal` would mark. */
export const hasInvisible = (value: string): boolean =>
  reveal(value).some((segment) => segment.mark);
