import * as cheerio from 'cheerio';

export interface QueueRow {
  rowId: string;
  originalId: number;
  translationId: number;
  source: string;
  sourcePlural?: string | undefined;
  translation: string;
  translationPlural?: string | undefined;
  context?: string | undefined;
  status?: string | undefined;
  approveNonce?: string | undefined;
  rejectNonce?: string | undefined;
}

export interface QueuePageResult {
  setStatusUrl: string;
  rows: QueueRow[];
  nextPageUrl?: string | undefined;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

export function decodeHtml(str: string): string {
  return str
    .replace(/&#(\d+);/g, (_, code: string) => {
      const num = Number(code);
      return Number.isFinite(num) && num >= 0 && num <= 0x10ffff ? String.fromCodePoint(num) : _;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      const num = parseInt(hex, 16);
      return Number.isFinite(num) && num >= 0 && num <= 0x10ffff ? String.fromCodePoint(num) : _;
    })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&hellip;/g, '…')
    .replace(/&minus;/g, '-');
}

function extractCellForms($: cheerio.CheerioAPI, $cell: cheerio.Cheerio<any>, spanClass: string): string[] {
  const $lis = $cell.find('ul li');
  if ($lis.length > 0) {
    const forms: string[] = [];
    $lis.each((_, li) => {
      const $span = $(li).find(`.${spanClass}`);
      forms.push($span.length > 0 ? $span.text() : $(li).text());
    });
    return forms.length > 0 ? forms : [''];
  }

  const $span = $cell.find(`.${spanClass}`);
  return $span.length > 0 ? [$span.text()] : [$cell.text()];
}

/**
 * Parses rows, status URL, and next page link from a GlotPress translation set page HTML using Cheerio.
 */
export function parseQueuePage(html: string, pageUrl: string): QueuePageResult {
  let setStatusUrl = '';
  const statusMatch = /set_status_url["']?\s*:\s*["']([^"']+)["']/i.exec(html);
  if (statusMatch && statusMatch[1]) {
    const raw = statusMatch[1];
    setStatusUrl = raw.startsWith('http') ? raw : new URL(raw, pageUrl).toString();
  } else {
    const base = pageUrl.split('?')[0]!;
    setStatusUrl = base.endsWith('/') ? `${base}-set-status/` : `${base}/-set-status/`;
  }

  const $ = cheerio.load(html);
  const rows: QueueRow[] = [];

  $('tr.preview').each((_, el) => {
    const $row = $(el);
    const rowId = ($row.attr('row') ?? '').trim();
    if (!rowId) return;

    const [origStr, transStr] = rowId.split('-');
    const originalId = Number(origStr);
    const translationId = transStr ? Number(transStr) : null;
    if (!Number.isFinite(originalId) || originalId === 0 || !translationId) return;

    const classAttr = $row.attr('class') ?? '';
    const rowStatusMatch = /\bstatus-([a-z]+)\b/i.exec(classAttr);
    const status = rowStatusMatch && rowStatusMatch[1] ? rowStatusMatch[1].toLowerCase() : undefined;

    // Source cell
    const $origCell = $row.find('td.original');
    const srcForms = extractCellForms($, $origCell, 'original-text');

    // Translation cell
    const $transCell = $row.find('td.translation');
    const transForms = extractCellForms($, $transCell, 'translation-text');

    // Context bubble
    const $context = $row.find('.context.bubble');
    const context = $context.length > 0 ? $context.text().trim() : undefined;

    // Approve & reject nonces
    const approveNonce =
      $row.find('button.inline-action-approve, button.approve').first().attr('data-nonce') || undefined;
    const rejectNonce =
      $row.find('button.inline-action-reject, button.reject').first().attr('data-nonce') || undefined;

    rows.push({
      rowId,
      originalId,
      translationId,
      source: srcForms[0] ?? '',
      ...(srcForms[1] ? { sourcePlural: srcForms[1] } : {}),
      translation: transForms[0] ?? '',
      ...(transForms[1] ? { translationPlural: transForms[1] } : {}),
      ...(context ? { context } : {}),
      ...(status ? { status } : {}),
      approveNonce,
      rejectNonce,
    });
  });

  // Next page detection
  let nextPageUrl: string | undefined;
  let nextHref: string | undefined;
  $('div.paging a').each((_, el) => {
    const $a = $(el);
    const isNext =
      $a.hasClass('next') ||
      /(?:→|&rarr;|Next|Sonraki)/i.test($a.text()) ||
      /\bnext\b/i.test($a.attr('class') ?? '');
    if (isNext) {
      nextHref = $a.attr('href');
      return false; // break loop
    }
  });

  if (nextHref) {
    const raw = decodeHtml(nextHref).trim();
    nextPageUrl = raw.startsWith('http') ? raw : new URL(raw, pageUrl).toString();
  }

  return {
    setStatusUrl,
    rows,
    nextPageUrl,
  };
}

/**
 * Fetches one page of a GlotPress translation queue and parses its rows.
 */
export async function fetchQueuePage(
  url: string,
  cookie: string,
  signal?: AbortSignal,
): Promise<QueuePageResult> {
  const fetchInit: RequestInit = {
    headers: {
      Cookie: cookie.trim(),
      'User-Agent': DEFAULT_USER_AGENT,
    },
  };
  if (signal) fetchInit.signal = signal;
  const res = await fetch(url, fetchInit);

  if (!res.ok) {
    throw new Error(`GlotPress kuyruk sayfası açılamadı (HTTP ${res.status}): ${url}`);
  }

  const html = await res.text();
  return parseQueuePage(html, url);
}

/**
 * Changes a translation's status on translate.wordpress.org (e.g. approve or reject).
 */
export async function setTranslationStatus(
  setStatusUrl: string,
  translationId: number,
  status: 'current' | 'rejected',
  nonce: string,
  cookie: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const body = new URLSearchParams({
    translation_id: String(translationId),
    status,
    _gp_route_nonce: nonce,
  });

  const postInit: RequestInit = {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: cookie.trim(),
      'User-Agent': DEFAULT_USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: setStatusUrl,
    },
    body: body.toString(),
  };
  if (signal) postInit.signal = signal;
  const res = await fetch(setStatusUrl, postInit);

  const finalUrl = res.url ? new URL(res.url) : new URL(setStatusUrl);
  const expectedUrl = new URL(setStatusUrl);
  const locationHeader = res.headers.get('location');
  const redirectUrl = locationHeader ? new URL(locationHeader, setStatusUrl) : null;
  const loginPage =
    finalUrl.hostname === 'login.wordpress.org' ||
    finalUrl.pathname === '/wp-login.php' ||
    redirectUrl?.hostname === 'login.wordpress.org' ||
    redirectUrl?.pathname === '/wp-login.php';
  const header = res.headers.get('x-glotpress-filter-counts');
  let validCounts = false;
  if (header) {
    try {
      const counts: unknown = JSON.parse(header);
      const fields = ['translated', 'untranslated', 'waiting', 'changesrequested', 'fuzzy', 'warnings'];
      validCounts = typeof counts === 'object' && counts !== null && !Array.isArray(counts) &&
        fields.every((field) => {
          const value = (counts as Record<string, unknown>)[field];
          return typeof value === 'string' && /^\d[\d\s.,\u00a0\u202f]*$/u.test(value);
        });
    } catch {
      validCounts = false;
    }
  }
  const responseBody = await res.text();
  let jsonOk = false;
  try {
    const data = JSON.parse(responseBody) as Record<string, unknown>;
    if (data && (data.ok === true || data.success === true)) jsonOk = true;
  } catch {
    // not JSON
  }
  const $ = cheerio.load(responseBody, {}, false);
  let matchingRow = false;
  $('tr.preview').each((_, row) => {
    const rowId = $(row).attr('row') ?? '';
    if (rowId.endsWith(`-${translationId}`) && $(row).hasClass(`status-${status}`)) {
      matchingRow = true;
    }
  });
  if (!res.ok || finalUrl.origin !== expectedUrl.origin || loginPage || (!matchingRow && !validCounts && !jsonOk)) {
    const excerpt = $.text().replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new Error(`GlotPress durum güncellemesi doğrulanamadı (HTTP ${res.status}): ${excerpt}`);
  }

  return true;
}
