export interface GlotPressStats {
  translated: number;
  fuzzy: number;
  waiting: number;
  untranslated: number;
  total: number;
  percent: number;
}

const parseNum = (str?: string | null): number => {
  if (!str) return 0;
  const cleaned = str.replace(/[^\d]/g, '');
  return cleaned ? parseInt(cleaned, 10) : 0;
};

/**
 * Extracts translation counts from GlotPress HTML (either a translation set page
 * with .filter-toolbar or a locale overview table).
 */
export function parseGlotPressStats(html: string): GlotPressStats {
  const stats: GlotPressStats = {
    translated: 0,
    fuzzy: 0,
    waiting: 0,
    untranslated: 0,
    total: 0,
    percent: 0,
  };

  // Pattern 1: Filter toolbar links, e.g. "Translated&nbsp;(5,370)" or "Translated (5370)"
  const allMatch = /All(?:&nbsp;|\s)*\(([\d,.]+)\)/i.exec(html);
  const transMatch = /Translated(?:&nbsp;|\s)*\(([\d,.]+)\)/i.exec(html);
  const untransMatch = /Untranslated(?:&nbsp;|\s)*\(([\d,.]+)\)/i.exec(html);
  const waitingMatch = /Waiting(?:&nbsp;|\s)*\(([\d,.]+)\)/i.exec(html);
  const fuzzyMatch = /Fuzzy(?:&nbsp;|\s)*\(([\d,.]+)\)/i.exec(html);

  if (allMatch || transMatch || untransMatch) {
    stats.total = parseNum(allMatch?.[1]);
    stats.translated = parseNum(transMatch?.[1]);
    stats.untranslated = parseNum(untransMatch?.[1]);
    stats.waiting = parseNum(waitingMatch?.[1]);
    stats.fuzzy = parseNum(fuzzyMatch?.[1]);

    if (stats.total === 0) {
      stats.total = stats.translated + stats.untranslated + stats.waiting + stats.fuzzy;
    }
    stats.percent = stats.total > 0 ? Math.round((stats.translated / stats.total) * 100) : 0;
    return stats;
  }

  // Pattern 2: Locale sub-projects table, e.g. td.stats.translated > a
  const transTd = /<td[^>]*class="[^"]*stats translated[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\d,.]+)<\/a>/i.exec(html);
  const fuzzyTd = /<td[^>]*class="[^"]*stats fuzzy[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\d,.]+)<\/a>/i.exec(html);
  const untransTd = /<td[^>]*class="[^"]*stats untranslated[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\d,.]+)<\/a>/i.exec(html);
  const waitingTd = /<td[^>]*class="[^"]*stats waiting[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\d,.]+)<\/a>/i.exec(html);
  const percentSpan = /<span[^>]*class="[^"]*sub-project-status[^"]*"[^>]*>(\d+)\s*%/i.exec(html);

  if (transTd || untransTd) {
    stats.translated = parseNum(transTd?.[1]);
    stats.fuzzy = parseNum(fuzzyTd?.[1]);
    stats.untranslated = parseNum(untransTd?.[1]);
    stats.waiting = parseNum(waitingTd?.[1]);
    stats.total = stats.translated + stats.untranslated + stats.waiting + stats.fuzzy;
    stats.percent = percentSpan ? parseNum(percentSpan[1]) : (stats.total > 0 ? Math.round((stats.translated / stats.total) * 100) : 0);
  }

  return stats;
}

/**
 * Fetch live GlotPress stats from translate.wordpress.org with pacing & fallback.
 */
export async function fetchProjectStats(url: string, signal?: AbortSignal): Promise<GlotPressStats> {
  const init: RequestInit = {
    method: 'GET',
    headers: {
      'User-Agent': 'wp-translator/1.0 (+https://github.com/turker/wp-translator)',
      Accept: 'text/html,application/xhtml+xml',
    },
  };
  if (signal) init.signal = signal;

  const response = await fetch(url, init);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} when fetching stats from ${url}`);
  }

  const html = await response.text();
  return parseGlotPressStats(html);
}
