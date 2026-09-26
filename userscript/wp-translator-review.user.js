// ==UserScript==
// @name         wp-translator · bekleyen çevirileri değerlendir
// @namespace    https://github.com/turker/wp-translator
// @version      1.0.1
// @description  Bekleyen ve fuzzy çevirileri yerel wp-translator sunucusuna sorar; sözlükle birebir eşleşenleri onaylar, kalanları işaretler.
// @match        https://translate.wordpress.org/projects/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// @noframes
// ==/UserScript==

'use strict';

/**
 * The local tool decides; this script only reads the page and reports back.
 *
 * GM_xmlhttpRequest is what reaches 127.0.0.1, so the server needs no CORS of
 * its own and nothing else on the page can talk to it.
 */
const SERVER = 'http://127.0.0.1:4173';
const BATCH = 10;
/** GlotPress pages at fifteen and ignores per_page, so pages are walked. */
const PAGE_SIZE = 15;

const state = { counted: 0, approved: 0, ticked: 0, unticked: 0, flagged: 0, unknown: 0, busy: false };

function ask(path, body) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'POST',
      url: `${SERVER}${path}`,
      headers: { 'content-type': 'application/json' },
      data: JSON.stringify(body),
      onload: (reply) => {
        if (reply.status !== 200) return reject(new Error(`${reply.status} ${reply.statusText}`));
        try {
          resolve(JSON.parse(reply.responseText));
        } catch (problem) {
          reject(problem);
        }
      },
      onerror: () => reject(new Error('Yerel sunucuya ulaşılamadı. wp-translator çalışıyor mu?')),
      ontimeout: () => reject(new Error('Yerel sunucu yanıt vermedi.')),
    });
  });
}

/** The project path as GlotPress spells it, e.g. `wp-themes/phlox`. */
function projectPath() {
  const match = /\/projects\/(.+?)\/[a-z]{2,3}(?:-[a-z]+)?\/default\//.exec(location.pathname);
  return match ? match[1] : '';
}

/** Every pending row on a document: its ids, its nonce, and the two strings. */
function readRows(root) {
  const rows = [];
  for (const preview of root.querySelectorAll('tr[row]')) {
    const row = preview.getAttribute('row');
    const translationId = Number(row.split('-')[1]);
    if (!Number.isFinite(translationId) || translationId === 0) continue;

    const source = preview.querySelector('.original-raw, .original-text');
    const translation = preview.querySelector('.translation-text');
    if (!source || !translation) continue;

    // The nonce is per row, so each one carries its own.
    const nonce =
      root.querySelector(`#editor-${row} [name="_gp_route_nonce"]`)?.value ??
      root.querySelector(`#editor-${row} a[href*="_gp_route_nonce="]`)
        ?.href?.match(/_gp_route_nonce=([^&]+)/)?.[1] ??
      null;

    rows.push({
      row,
      id: translationId,
      nonce,
      source: text(source),
      translation: text(translation),
      element: preview,
    });
  }
  return rows;
}

/** GlotPress renders these with the entities decoded by the browser already. */
const text = (element) => element.textContent ?? '';

async function fetchPage(page) {
  const url = new URL(location.href);
  url.searchParams.set('page', String(page));
  const reply = await fetch(url.toString(), { credentials: 'include' });
  const html = await reply.text();
  return new DOMParser().parseFromString(html, 'text/html');
}

async function setStatus(row, status) {
  if (!row.nonce) throw new Error('Bu satırın nonce değeri okunamadı.');

  const body = new URLSearchParams({
    translation_id: String(row.id),
    status,
    _gp_route_nonce: row.nonce,
  });
  const reply = await fetch(`${location.pathname}-set-status/`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: body.toString(),
  });
  if (!reply.ok) throw new Error(`${reply.status} ${reply.statusText}`);
}

/** Write the verdict where the owner will read it, without touching GlotPress's own nodes. */
function annotate(row, judgement) {
  const note = document.createElement('div');
  note.className = 'wpt-note';
  note.dataset.verdict = judgement.verdict;
  note.textContent = judgement.reason;
  if (judgement.expected) {
    const alt = document.createElement('div');
    alt.className = 'wpt-expected';
    alt.textContent = `önerilen: ${judgement.expected}`;
    note.append(alt);
  }
  row.element.querySelector('.translation-text')?.after(note);
}

/**
 * Tick the row for GlotPress's own bulk approve.
 *
 * The checkbox only exists for a user who may approve, so a missing one is
 * reported rather than ignored: it means the session cannot act here.
 */
function tick(row) {
  const box = row.element.querySelector('input[type="checkbox"]');
  if (!box) return false;
  if (!box.checked) box.click();
  return true;
}

async function run(panel, { approve }) {
  if (state.busy) return;
  state.busy = true;

  try {
    const pages = Math.max(1, Math.ceil(totalRows() / PAGE_SIZE));
    for (let page = 1; page <= pages; page += 1) {
      const document_ = page === 1 ? document : await fetchPage(page);
      const rows = readRows(document_);
      if (rows.length === 0) break;

      for (let at = 0; at < rows.length; at += BATCH) {
        const slice = rows.slice(at, at + BATCH);
        state.counted += slice.length;
        report(panel, `sayfa ${page}/${pages} · soruluyor…`);

        const { judgements } = await ask('/api/judge', {
          projectPath: projectPath(),
          items: slice.map((row) => ({
            id: row.id,
            source: row.source,
            translation: row.translation,
          })),
        });

        for (const judgement of judgements) {
          const row = slice.find((candidate) => candidate.id === judgement.id);
          if (!row) continue;

          if (judgement.verdict === 'exact' && approve) {
            await setStatus(row, 'current');
            state.approved += 1;
          } else if (judgement.verdict === 'exact' || judgement.verdict === 'agreed') {
            if (page === 1 && !tick(row)) state.unticked += 1;
            state.ticked += 1;
          } else if (judgement.verdict === 'flagged') {
            state.flagged += 1;
          } else {
            state.unknown += 1;
          }

          // Only the page on screen can be annotated; the rest are counted.
          if (page === 1) annotate(row, judgement);
        }
        report(panel, `sayfa ${page}/${pages}`);
      }
    }
    report(panel, 'bitti');
  } catch (problem) {
    report(panel, `hata: ${problem.message}`);
  } finally {
    state.busy = false;
  }
}

/** GlotPress prints the filtered total in the paging line. */
function totalRows() {
  const found = document.body.textContent?.match(/([\d.,]+)\s+strings?/i);
  return found ? Number(found[1].replace(/[.,]/g, '')) : PAGE_SIZE;
}

function report(panel, what) {
  panel.querySelector('.wpt-status').textContent =
    `${what} · ${state.counted} bakıldı · ${state.approved} onaylandı · ` +
    `${state.ticked} seçildi · ${state.flagged} işaretli · ${state.unknown} kararsız` +
    (state.unticked ? ` · ${state.unticked} kutucuk bulunamadı` : '');
}

/**
 * Whether this page has a queue to work through.
 *
 * GlotPress spells the filter `filters[status]`; the panel is shown either way
 * so that "the script did not run" and "the script had nothing to do" cannot
 * look the same.
 */
function pendingFilter() {
  const status = new URL(location.href).searchParams.get('filters[status]');
  return status === 'waiting' || status === 'fuzzy' || status === 'either' ? status : null;
}

function mount() {
  const panel = document.createElement('div');
  panel.id = 'wpt-panel';
  panel.innerHTML = `
    <style>
      #wpt-panel { position: fixed; inset-block-end: 12px; inset-inline-end: 12px; z-index: 9999;
        max-width: 420px; padding: 10px 12px; border-radius: 8px; font: 13px/1.5 system-ui, sans-serif;
        background: #111827; color: #f9fafb; box-shadow: 0 8px 24px rgb(0 0 0 / .4); }
      #wpt-panel button { font: inherit; margin-inline-end: 6px; padding: 3px 10px; cursor: pointer;
        border: 1px solid #6c727d; border-radius: 4px; background: transparent; color: inherit; }
      .wpt-status { display: block; margin-block-start: 6px; color: #b9bec7; }
      .wpt-note { margin-block-start: 4px; padding: 3px 6px; border-radius: 4px; font-size: 12px;
        background: #1c2332; color: #e6e8ec; }
      .wpt-note[data-verdict="exact"] { background: #0d2c2d; }
      .wpt-note[data-verdict="agreed"] { background: #122d40; }
      .wpt-note[data-verdict="flagged"] { background: #361c25; }
      .wpt-expected { color: #b9bec7; }
    </style>
    <b>wp-translator</b>
    <div>
      <button data-act="dry">Yalnızca değerlendir</button>
      <button data-act="live">Değerlendir ve birebir olanları onayla</button>
    </div>
    <span class="wpt-status">hazır</span>
  `;
  document.body.append(panel);

  const filter = pendingFilter();
  const rows = readRows(document).length;

  if (!filter) {
    for (const button of panel.querySelectorAll('button')) button.disabled = true;
    panel.querySelector('.wpt-status').textContent =
      'Bu sayfada bekleyen kuyruğu yok. Adrese ?filters[status]=waiting ekleyin.';
  } else if (rows === 0) {
    for (const button of panel.querySelectorAll('button')) button.disabled = true;
    panel.querySelector('.wpt-status').textContent =
      'Satır okunamadı. GTE olarak giriş yapılı mı?';
  } else {
    panel.querySelector('.wpt-status').textContent = `hazır · ${filter} · ${rows} satır okundu`;
  }

  panel.querySelector('[data-act="dry"]').addEventListener('click', () => run(panel, { approve: false }));
  panel.querySelector('[data-act="live"]').addEventListener('click', () => {
    if (confirm('Sözlükle birebir eşleşenler doğrudan onaylanacak. Devam edilsin mi?')) {
      void run(panel, { approve: true });
    }
  });
}

// Announced so a page with the script loaded can be told from one without it.
console.info('[wp-translator] yüklendi', location.pathname, pendingFilter() ?? '(filtresiz)');
mount();
