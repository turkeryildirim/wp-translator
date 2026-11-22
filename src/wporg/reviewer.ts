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
    .replace(/&minus;/g, '-')
    .trim();
}

function cleanText(html: string): string {
  return decodeHtml(html.replace(/<[^>]+>/g, ''));
}

/**
 * Extracts multiple forms (e.g. singular/plural) or a single text form from a table cell.
 */
function extractCellForms(cellHtml: string, textSpanClass: string): string[] {
  if (cellHtml.includes('<ul') && cellHtml.includes('<li')) {
    const forms: string[] = [];
    const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let lm: RegExpExecArray | null;
    while ((lm = liRegex.exec(cellHtml)) !== null) {
      const spanMatch = new RegExp(`<span class="${textSpanClass}">([\\s\\S]*?)<\\/span>`, 'i').exec(lm[1] ?? '');
      forms.push(spanMatch && spanMatch[1] ? cleanText(spanMatch[1]) : '');
    }
    if (forms.length > 0) return forms;
  }

  const singleMatch = new RegExp(`<span class="${textSpanClass}">([\\s\\S]*?)<\\/span>`, 'i').exec(cellHtml);
  return singleMatch && singleMatch[1] ? [cleanText(singleMatch[1])] : [''];
}

function extractButtonNonce(rowHtml: string, ...classNames: string[]): string | undefined {
  for (const cls of classNames) {
    const buttonRegex = new RegExp(`<button[^>]*class=["'][^"']*\\b${cls}\\b[^"']*["'][^>]*>`, 'gi');
    let bm: RegExpExecArray | null;
    while ((bm = buttonRegex.exec(rowHtml)) !== null) {
      const nonceMatch = /data-nonce=["']([^"']+)["']/i.exec(bm[0]);
      if (nonceMatch && nonceMatch[1]) {
        return nonceMatch[1];
      }
    }
  }
  return undefined;
}

/**
 * Parses rows, status URL, and next page link from a GlotPress translation set page HTML.
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

  const rows: QueueRow[] = [];
  const previewRegex = /<tr[^>]*class="[^"]*\bpreview\b[^"]*"[^>]*row="([^"]+)"[\s\S]*?<\/tr>/gi;

  let m: RegExpExecArray | null;
  while ((m = previewRegex.exec(html)) !== null) {
    const rowId = m[1] ?? '';
    const rowHtml = m[0];

    const [origStr, transStr] = rowId.split('-');
    const originalId = Number(origStr);
    const translationId = transStr ? Number(transStr) : null;
    if (!Number.isFinite(originalId) || originalId === 0 || !translationId) continue;

    const rowStatusMatch = /\bstatus-([a-z]+)\b/i.exec(rowHtml);
    const status = rowStatusMatch && rowStatusMatch[1] ? rowStatusMatch[1].toLowerCase() : undefined;

    // Source cell
    const origCellMatch = /<td class="original"[^>]*>([\s\S]*?)<\/td>/i.exec(rowHtml);
    const origCell = origCellMatch && origCellMatch[1] ? origCellMatch[1] : '';
    const srcForms = extractCellForms(origCell, 'original-text');

    // Translation cell
    const transCellMatch = /<td class="translation[^"]*"[^>]*>([\s\S]*?)<\/td>/i.exec(rowHtml);
    const transCell = transCellMatch && transCellMatch[1] ? transCellMatch[1] : '';
    const transForms = extractCellForms(transCell, 'translation-text');

    // Context bubble
    const ctxtMatch = /<span class="context bubble">([\s\S]*?)<\/span>/i.exec(rowHtml);
    const context = ctxtMatch && ctxtMatch[1] ? cleanText(ctxtMatch[1]) : undefined;

    // Approve & reject nonces
    const approveNonce = extractButtonNonce(rowHtml, 'inline-action-approve', 'approve');
    const rejectNonce = extractButtonNonce(rowHtml, 'inline-action-reject', 'reject');

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
  }

  // Next page detection
  let nextPageUrl: string | undefined;
  const pagingMatch = /<div class="paging">([\s\S]*?)<\/div>/i.exec(html);
  if (pagingMatch && pagingMatch[1]) {
    const pagingHtml = pagingMatch[1];
    const aRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let am: RegExpExecArray | null;
    let nextHref: string | undefined;
    while ((am = aRegex.exec(pagingHtml)) !== null) {
      const attrs = am[1] ?? '';
      const text = am[2] ?? '';
      const hasNextClass = /\bclass=["'][^"']*\bnext\b[^"']*["']/i.test(attrs);
      const isNextText = /(?:&rarr;|Next|Sonraki)/i.test(text);
      if (hasNextClass || isNextText) {
        const hrefMatch = /\bhref=["']([^"']+)["']/i.exec(attrs);
        if (hrefMatch && hrefMatch[1]) {
          nextHref = hrefMatch[1];
          break;
        }
      }
    }
    if (nextHref) {
      const raw = decodeHtml(nextHref);
      nextPageUrl = raw.startsWith('http') ? raw : new URL(raw, pageUrl).toString();
    }
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
    headers: {
      Cookie: cookie.trim(),
      'User-Agent': DEFAULT_USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Referer: setStatusUrl,
    },
    body: body.toString(),
  };
  if (signal) postInit.signal = signal;
  const res = await fetch(setStatusUrl, postInit);

  if (!res.ok) {
    const text = (await res.text()).trim().slice(0, 200);
    throw new Error(`GlotPress status güncelleme başarısız (HTTP ${res.status}): ${text}`);
  }

  return true;
}
