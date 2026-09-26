// ==UserScript==
// @name         wp-translator · bekleyen çevirileri değerlendir
// @namespace    https://github.com/turker/wp-translator
// @version      1.1.1
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

const state = { counted: 0, approved: 0, refused: 0, ticked: 0, unticked: 0, flagged: 0, unknown: 0, busy: false };

function ask(path, body) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'POST',
      url: `${SERVER}${path}`,
      headers: { 'content-type': 'application/json' },
      data: JSON.stringify(body),
      onload: (reply) => {
        if (reply.status !== 200) {
          // The body carries the server's own reason; without it a failure reads
          // only as "500" and says nothing about what to fix.
          const detail = (reply.responseText || '').trim().slice(0, 300);
          return reject(new Error(`${reply.status} ${reply.statusText}${detail ? ` — ${detail}` : ''}`));
        }
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

/**
 * Every pending row on a document: its ids, its nonce, and the two strings.
 *
 * GlotPress renders two `<tr row="…">` per string, the preview and the editor,
 * so the preview is selected by class and the editor is read for the nonce.
 */
function readRows(root) {
  const rows = [];
  for (const preview of root.querySelectorAll('tr.preview[row]')) {
    const row = preview.getAttribute('row');
    const translationId = Number(row.split('-')[1]);
    if (!Number.isFinite(translationId) || translationId === 0) continue;

    const source = forms(preview, 'td.original', '.original-text');
    const translation = forms(preview, 'td.translation', '.translation-text');
    if (!source[0] || !translation.some((form) => form !== null)) continue;

    const editor = root.querySelector(`#editor-${row}`);
    rows.push({
      row,
      id: translationId,
      nonce: statusNonce(editor, 'approve'),
      source: source[0],
      ...(source[1] ? { sourcePlural: source[1] } : {}),
      translation: translation[0] ?? '',
      ...(translation[1] ? { translationPlural: translation[1] } : {}),
      element: preview,
      editor,
    });
  }
  return rows;
}

/**
 * The forms in one cell, in order, with a missing one as null.
 *
 * A plural string is a `<ul>` of one `<li>` per form, and a form nobody filled
 * carries `.missing` instead of the text span — so position matters and the spans
 * alone cannot be counted. Judging a plural row on its singular half is how an
 * untranslated plural gets approved.
 */
function forms(preview, cell, span) {
  const container = preview.querySelector(cell);
  const items = container?.querySelectorAll(':scope > ul > li') ?? [];
  if (items.length > 0) {
    return [...items].map((item) => item.querySelector(span)?.textContent ?? null);
  }
  return [container?.querySelector(span)?.textContent ?? null];
}

/**
 * The nonce for one status change on one row.
 *
 * GlotPress mints a separate nonce per row and per target status and puts it on
 * the button that performs it, which is rendered only for a session allowed to
 * use it. So a missing nonce means this session may not set that status here.
 */
function statusNonce(editor, action) {
  const button = editor?.querySelector(`button.${action}[data-nonce]`);
  if (button) return button.dataset.nonce;
  if (editor) {
    console.warn(
      `[wp-translator] ${editor.id} içinde button.${action} bulunamadı:`,
      editor.outerHTML.slice(0, 1500),
    );
  }
  return null;
}

async function fetchPage(page) {
  const url = new URL(location.href);
  url.searchParams.set('page', String(page));
  const reply = await fetch(url.toString(), { credentials: 'include' });
  const html = await reply.text();
  return new DOMParser().parseFromString(html, 'text/html');
}

/**
 * GlotPress's own editor settings, as `wp_localize_script` leaves them.
 *
 * Read out of the inline script rather than off `window`, because a userscript
 * sandbox does not share the page's globals and a fetched page has none at all.
 */
function editorOptions(root) {
  for (const script of root.querySelectorAll('script:not([src])')) {
    const found = /var \$gp_editor_options\s*=\s*(\{.*?\});/s.exec(script.textContent ?? '');
    if (!found) continue;
    try {
      return JSON.parse(found[1]);
    } catch {
      // Not fatal: every URL this script needs can be derived from the path.
    }
  }
  return {};
}

const setStatusUrl = () => editorOptions(document).set_status_url ?? `${location.pathname}-set-status/`;

async function setStatus(row, status) {
  if (!row.nonce) {
    throw new Error(
      `Bu satırda "${status}" için nonce yok — oturumun bu projede onaylama yetkisi görünmüyor.`,
    );
  }

  const body = new URLSearchParams({
    translation_id: String(row.id),
    status,
    _gp_route_nonce: row.nonce,
  });
  const reply = await fetch(setStatusUrl(), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: body.toString(),
  });
  if (!reply.ok) {
    throw new Error(`${reply.status} ${reply.statusText} — ${(await reply.text()).trim().slice(0, 200)}`);
  }

  return savedStatus(await reply.text());
}

/**
 * The status a save landed on, read out of the row GlotPress sends back.
 *
 * A translation that trips GlotPress's own warnings is stored as `waiting` even
 * for a user who may approve, and the request still succeeds — so "saved" on its
 * own would be a claim the reply does not make. The answer is keyed by original
 * id and carries the re-rendered row.
 */
function savedStatus(body) {
  let rendered = body;
  try {
    rendered = Object.values(JSON.parse(body)).join('');
  } catch {
    // Not JSON: fall back to scanning whatever came back.
  }
  const found = /\bstatus-([a-z]+)\b/.exec(rendered);
  return found ? found[1] : 'bilinmiyor';
}

/** Clear the row's bulk-approve tick. True when one was set. */
function untick(row) {
  const box = row.element.querySelector('input[type="checkbox"]');
  if (!box?.checked) return false;
  box.click();
  return true;
}

/** Write the verdict where the owner will read it, without touching GlotPress's own nodes. */
function annotate(row, judgement) {
  const note = document.createElement('div');
  note.className = 'wpt-note';
  note.dataset.verdict = judgement.verdict;
  note.textContent = judgement.reason;

  if (judgement.expected) {
    note.append(
      judgement.proposal
        ? applyButton(row, judgement.proposal)
        : Object.assign(document.createElement('div'), {
            className: 'wpt-expected',
            textContent: `önerilen: ${judgement.expected}`,
          }),
    );
  }
  row.element.querySelector('.translation-text')?.after(note);
}

/**
 * The proposed wording, as a button that writes it into the row and saves it.
 *
 * Only a wording the server passed through the quality checks arrives here, and
 * only ever on a click: it replaces somebody else's pending submission.
 */
function applyButton(row, proposal) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'wpt-apply';
  button.title = 'Bu çeviriyi satıra yaz ve kaydet';
  button.textContent = `önerilen: ${proposal}`;

  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const status = await applyProposal(row, proposal);
      // GlotPress restores an older translation by making it current again, so a
      // row left ticked would have this wording undone by its own bulk approve.
      if (untick(row)) state.ticked -= 1;
      button.dataset.done = 'yes';
      button.textContent =
        status === 'current'
          ? `kaydedildi: ${proposal}`
          : `kaydedildi ama durumu "${status}" — elle onaylamak gerekiyor: ${proposal}`;
    } catch (problem) {
      button.disabled = false;
      button.textContent = `kaydedilemedi: ${problem.message}`;
    }
  });

  return button;
}

/**
 * Save a wording as this row's translation, the way GlotPress's own editor does.
 *
 * The textarea is filled first so the wording is in place and visible even if the
 * request fails, and so the page shows the same thing the request sent. Returns
 * the status the save actually produced, which is not always `current`.
 */
async function applyProposal(row, proposal) {
  const originalId = row.row.split('-')[0];
  const nonce = row.editor?.querySelector('button.ok[data-nonce]')?.dataset.nonce;
  if (!nonce) {
    throw new Error('bu satırda kaydetme yetkisi görünmüyor');
  }

  const field = `translation[${originalId}][]`;
  const areas = row.editor.querySelectorAll(`textarea[name="${CSS.escape(field)}"]`);
  if (areas.length !== 1) {
    // One wording cannot fill several plural forms, and the request sends every
    // one it finds: a partial save would empty the others.
    throw new Error(`${areas.length} çeviri alanı var, tek karşılık yazılamaz`);
  }
  areas[0].value = proposal;

  const body = new URLSearchParams({ original_id: originalId, _gp_route_nonce: nonce });
  body.append(field, proposal);

  const reply = await fetch(editorOptions(document).url ?? location.pathname, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: body.toString(),
  });
  if (!reply.ok) {
    throw new Error(`${reply.status} ${reply.statusText} — ${(await reply.text()).trim().slice(0, 200)}`);
  }
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
            ...(row.sourcePlural ? { sourcePlural: row.sourcePlural } : {}),
            translation: row.translation,
            ...(row.translationPlural ? { translationPlural: row.translationPlural } : {}),
          })),
        });

        for (const judgement of judgements) {
          const row = slice.find((candidate) => candidate.id === judgement.id);
          if (!row) continue;

          if (judgement.verdict === 'exact' && approve) {
            // One row the session cannot act on must not end a run of dozens of
            // pages; it is reported where it happened and the walk goes on.
            try {
              await setStatus(row, 'current');
              state.approved += 1;
            } catch (problem) {
              state.refused += 1;
              if (page === 1) annotate(row, { verdict: 'unknown', reason: `onaylanamadı: ${problem.message}` });
            }
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
    (state.refused ? ` · ${state.refused} onaylanamadı` : '') +
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
      .wpt-apply { display: block; margin-block-start: 4px; max-width: 100%; text-align: start;
        padding: 3px 6px; border: 1px solid #5a6472; border-radius: 4px; cursor: pointer;
        background: #1c2430; color: #e7e9ee; font: inherit; white-space: normal; }
      .wpt-apply:hover:not(:disabled) { border-color: #8ea2bd; }
      .wpt-apply[data-done="yes"] { border-color: #2f7d4f; cursor: default; }
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
