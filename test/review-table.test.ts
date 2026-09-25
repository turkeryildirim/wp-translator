import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../panel/src/${name}`, import.meta.url)), 'utf-8');

describe('the review table', () => {
  it('is a table, not a stack of positioned boxes', () => {
    // Positioned boxes at a fixed height overlap when a string is longer than
    // one line, and the height has to be repeated in the stylesheet.
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

  it('starts a different project at the beginning', () => {
    // Carrying a page number across asks the new project for an offset it may
    // not reach, which answers with counts but no rows.
    const app = read('App.vue');
    const onSelect = app.slice(app.indexOf('watch(selected,'), app.indexOf('watch(page,'));
    expect(onSelect).toContain('page.value = 0');
    expect(onSelect).toContain('clearSelection()');
  });

  it('reloads when the page number moves', () => {
    // The pager only sets the number; without a watcher the list never changes.
    const app = read('App.vue');
    expect(app).toMatch(/watch\(page, load\)/);
  });

  it('offers a way to copy the source verbatim', () => {
    // Reproducing a source's whitespace and directional marks by hand is
    // guesswork, and those are exactly the characters that break an import.
    const script = read('ReviewTable.vue').split('<template>')[0] ?? '';
    expect(script).toContain("setDraft(unit, 'one', unit.msgid)");
    expect(script).toContain("setDraft(unit, 'many', unit.msgidPlural)");
  });

  it('does not gate approval on the stored translation’s failures', () => {
    // `unit.failures` describes what is saved, not what is in the box, so
    // gating on it refuses the very edit that fixes a blocked string.
    const template = read('ReviewTable.vue').split('<template>')[1] ?? '';
    expect(template).not.toMatch(/:disabled="[^"]*failures[^"]*"/);
  });

  it('keeps the editor out of the rows', () => {
    // Editing belongs in the detail panel, which is the only place a sentence
    // fits and the only one that can grow without moving anything else.
    const template = read('ReviewTable.vue').split('<template>')[1] ?? '';
    const rows = template.slice(template.indexOf('<tbody>'), template.indexOf('</tbody>'));
    expect(rows).not.toContain('<textarea');
  });
});
