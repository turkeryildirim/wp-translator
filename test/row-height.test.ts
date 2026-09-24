import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../panel/src/${name}`, import.meta.url)), 'utf-8');

describe('the virtualised row height', () => {
  it('is the same number in the component and the stylesheet', () => {
    // Rows are absolutely positioned from ROW_HEIGHT while the browser draws
    // them at the stylesheet's height. A disagreement does not fail anywhere —
    // the list just drifts, a little further with every row, and the cursor
    // lands on the wrong string.
    const script = /const ROW_HEIGHT = (\d+);/.exec(read('ReviewTable.vue'));
    const style = /\.row \{[^}]*height: (\d+)px/.exec(read('style.css'));

    expect(script?.[1]).toBeDefined();
    expect(style?.[1]).toBeDefined();
    expect(script![1]).toBe(style![1]);
  });

  it('is not repeated as a literal in the template', () => {
    // It was, twice, which is two more places to forget.
    const template = read('ReviewTable.vue').split('<template>')[1] ?? '';
    expect(template).not.toMatch(/\*\s*34\b|\b34\s*\+/);
  });
});
