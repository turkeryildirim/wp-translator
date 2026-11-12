import { describe, expect, it } from 'vitest';
import { parseGlotPressStats } from '../src/wporg/stats.ts';

describe('parseGlotPressStats', () => {
  it('parses filter-toolbar counts with commas and nbsp', () => {
    const html = `
      <div class="filter-toolbar">
        <div>
          <a href="#" class="filter-current">All&nbsp;(5,370)</a>
          <a href="?filters[status]=current">Translated&nbsp;(5,370)</a>
          <a href="?filters[status]=untranslated">Untranslated&nbsp;(42)</a>
          <a href="?filters[status]=waiting">Waiting&nbsp;(15)</a>
          <a href="?filters[status]=fuzzy">Fuzzy&nbsp;(8)</a>
        </div>
      </div>
    `;

    const stats = parseGlotPressStats(html);
    expect(stats.total).toBe(5370);
    expect(stats.translated).toBe(5370);
    expect(stats.untranslated).toBe(42);
    expect(stats.waiting).toBe(15);
    expect(stats.fuzzy).toBe(8);
    expect(stats.percent).toBe(100);
  });

  it('parses locale sub-projects table format', () => {
    const html = `
      <table class="gp-table locale-sub-projects">
        <tr>
          <td class="set-name">
            <strong>Stable</strong>
            <span class="sub-project-status percent-90">94%</span>
          </td>
          <td class="stats translated"><a href="#">4,190</a></td>
          <td class="stats fuzzy"><a href="#">14</a></td>
          <td class="stats untranslated"><a href="#">182</a></td>
          <td class="stats waiting"><a href="#">86</a></td>
        </tr>
      </table>
    `;

    const stats = parseGlotPressStats(html);
    expect(stats.translated).toBe(4190);
    expect(stats.fuzzy).toBe(14);
    expect(stats.waiting).toBe(86);
    expect(stats.untranslated).toBe(182);
    expect(stats.total).toBe(4190 + 14 + 86 + 182);
    expect(stats.percent).toBe(94);
  });
});
