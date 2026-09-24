export interface Segment {
  text: string;
  /** True when this stands in for characters that have no appearance. */
  mark: boolean;
  /** What the marker stands for, for a tooltip. */
  title?: string;
}

export interface Marker {
  /** The stand-in that is drawn. */
  text: string;
  /** What it stands for, in words. */
  label: string;
  /** How the character is written, for the legend and the tooltip. */
  note: string;
}

const GLYPH: Record<string, Marker> = {
  '\t': { text: '→', label: 'sekme', note: '\\t' },
  '\n': { text: '¶', label: 'satır sonu', note: '\\n' },
  '\r': { text: '␍', label: 'satır başı', note: '\\r' },
  ' ': { text: '␣', label: 'bölünmez boşluk', note: 'U+00A0' },
};

const SPACE: Marker = { text: '·', label: 'boşluk', note: 'baş, son ya da ardışık' };
const NAMED: Marker = { text: '‹U+…›', label: 'görünmez karakter', note: 'kod noktasıyla' };

/**
 * Every marker `reveal` can produce, built from the same table the rendering
 * uses so the legend cannot fall out of step with the screen.
 */
export const LEGEND: readonly Marker[] = [SPACE, ...Object.values(GLYPH), NAMED];

const titleOf = (marker: Marker): string => `${marker.label} (${marker.note})`;

/**
 * Anything else with no appearance: format characters, other space separators,
 * line and paragraph separators, C0/C1 controls. Named by codepoint, since
 * there is no convention for them and an invented glyph reads as ordinary text.
 */
const NAMELESS = /[\p{Cf}\p{Zs}\p{Zl}\p{Zp}\p{Cc}]/u;

/**
 * Split a string into plain runs and stand-ins for the characters it does not
 * draw — a trailing space, a tab, a missing `\n`, a stray directional mark.
 *
 * Single spaces between words are left alone: marking every one turns the
 * column into dots and hides the cases that matter. A space is shown only when
 * it leads, trails, or comes in a run.
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
        segments.push({
          text: SPACE.text.repeat(run),
          mark: true,
          title: `${run} ${SPACE.label}`,
        });
      } else {
        plain += ' ';
      }
      at = end - 1;
      continue;
    }

    const glyph = GLYPH[character];
    if (glyph) {
      flush();
      segments.push({ text: glyph.text, mark: true, title: titleOf(glyph) });
      continue;
    }

    if (NAMELESS.test(character)) {
      flush();
      const code = character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
      segments.push({ text: `‹U+${code}›`, mark: true, title: `${NAMED.label} U+${code}` });
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
