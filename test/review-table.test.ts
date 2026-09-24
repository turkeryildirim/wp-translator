import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../panel/src/${name}`, import.meta.url)), 'utf-8');

describe('the review table', () => {
  it('is a table, not a stack of positioned boxes', () => {
    // It was a list of absolutely positioned divs at a fixed height — what
    // virtualisation needed while the screen loaded all 3 116 strings at once.
    // Paging removed the reason and left the costs: a long string overlapped
    // the row beneath it, and the height lived in two files that could
    // disagree.
    const template = read('ReviewTable.vue').split('<template>')[1] ?? '';

    expect(template).toContain('<table class="grid">');
    expect(template).toContain('<thead>');
    expect(read('ReviewTable.vue')).not.toContain('ROW_HEIGHT');
    expect(template).not.toMatch(/position: absolute|class="spacer"/);
  });

  it('reveals invisible characters in both columns', () => {
    // Same as the glossary: a trailing space or a stray U+200E is exactly what
    // a reviewer is looking for, and neither column draws it on its own.
    const template = read('ReviewTable.vue').split('<template>')[1] ?? '';
    const rows = template.slice(template.indexOf('<tbody>'), template.indexOf('</tbody>'));
    expect(rows.match(/<Reveal/g) ?? []).toHaveLength(2);
  });

  it('names its columns', () => {
    // The grid is divs, not a table, so nothing labels the columns unless a
    // header row does.
    const template = read('ReviewTable.vue').split('<template>')[1] ?? '';
    const head = template.slice(template.indexOf('<thead>'), template.indexOf('</thead>'));
    expect(head).toContain('Kaynak');
    expect(head).toContain('Çeviri');
  });

  it('keeps the editor out of the rows', () => {
    // Editing belongs in the detail panel, which is the only place a sentence
    // fits and the only one that can grow without moving anything else.
    const template = read('ReviewTable.vue').split('<template>')[1] ?? '';
    const rows = template.slice(template.indexOf('<tbody>'), template.indexOf('</tbody>'));
    expect(rows).not.toContain('<textarea');
  });
});
