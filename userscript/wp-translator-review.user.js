// ==UserScript==
// @name         wp-translator · bekleyen çevirileri değerlendir
// @namespace    https://github.com/turker/wp-translator
// @version      1.7.1
// @description  Açık sayfadaki bekleyen ve fuzzy çevirileri yerel wp-translator sunucusuna sorar; sözlükle birebir eşleşenleri onaylar, kalanları gerekçesiyle işaretler.
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
/** How many rows go to the server at once. Whatever the page holds is sliced into these. */
const BATCH = 10;

/**
 * The queues this script works on.
 *
 * `waiting` and `fuzzy` carry somebody's wording, which is judged. `untranslated`
 * carries none, so there is nothing to judge and the tool proposes one instead —
 * the decision is per row, not per queue, because `either` and `fuzzy` mix the two.
 */
const QUEUES = ['waiting', 'fuzzy', 'untranslated', 'either'];

/**
 * Which CLI translates a proposal, and with what.
 *
 * Judging goes through whatever the server is configured for; proposing needs a
 * translator, and this is the one combination measured to answer. Edit it here if
 * the plan or the model changes.
 */
const ENGINE = { engine: 'opencode', agent: 'wp-translator', model: 'zai-coding-plan/glm-5.3-flash' };

/** Consecutive batches with nothing but `unknown` before the run gives up. */
const SILENT_LIMIT = 2;
/**
 * How many batches are in flight at once, and how far apart they start.
 *
 * One request is one model call, so this is what decides how many of those run
 * together. The stagger keeps the lanes from arriving in the same instant.
 */
const LANES = 3;
const STAGGER_MS = 2_000;

const state = { counted: 0, approved: 0, refused: 0, ticked: 0, unticked: 0, flagged: 0, proposed: 0, unknown: 0, failed: 0, silent: 0, stopped: '', busy: false };

/** Clear the last run, so a second pass over the page neither doubles its counts nor its notes. */
function reset() {
  for (const key of Object.keys(state)) if (key !== 'busy') state[key] = 0;
  state.stopped = '';
  for (const note of document.querySelectorAll('.wpt-note')) note.remove();
}

/**
 * Ask the local tool, with a deadline longer than its own.
 *
 * A batch the model stalls on is killed server-side and answered with `unknown`
 * verdicts, which takes as long as that timeout. Without a deadline of our own
 * the request is abandoned before that answer arrives, and reported as a server
 * that cannot be reached.
 */
const REQUEST_TIMEOUT_MS = 300_000;

function ask(path, body, method = 'POST') {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method,
      url: `${SERVER}${path}`,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, data: JSON.stringify(body) }),
      timeout: REQUEST_TIMEOUT_MS,
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
      onerror: (reply) => {
        // Two very different causes read the same from here: the server is not
        // listening, or the extension refused the cross-origin request — which it
        // asks about again on a new script version. What it hands back is the only
        // thing that tells them apart.
        const detail = [reply?.error, reply?.status ? `status ${reply.status}` : '']
          .filter(Boolean)
          .join(' ');
        reject(
          new Error(
            `${SERVER} adresine ulaşılamadı${detail ? ` (${detail})` : ''}. ` +
              'Sunucu çalışıyorsa Tampermonkey bu betiğin bağlantı iznini soruyor olabilir — ' +
              'yeni sürümde yeniden sorar.',
          ),
        );
      },
      ontimeout: () =>
        reject(new Error(`Yerel sunucu ${REQUEST_TIMEOUT_MS / 1000} saniyede yanıt vermedi.`)),
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
    // A row with no translation at all is kept: it is the one to propose for.
    if (!source[0]) continue;

    const editor = root.querySelector(`#editor-${row}`);
    rows.push({
      row,
      id: translationId,
      nonce: actionNonce(editor, 'approve'),
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
 * The nonce for one action on one row.
 *
 * GlotPress mints a separate nonce per row and per action and puts it on the
 * button that performs it, which is rendered only for a session allowed to use
 * it — so a missing nonce means this session may not do that here. Two selectors
 * per action because translate.wordpress.org replaces the editor row's template
 * and renames its save button.
 */
const ACTION_BUTTONS = {
  approve: ['button.approve'],
  reject: ['button.reject'],
  // translate.wordpress.org renames GlotPress's save button; both are accepted.
  save: ['button.translation-actions__save', 'button.ok'],
};

function actionNonce(editor, action) {
  const selectors = ACTION_BUTTONS[action];
  const button = editor?.querySelector(selectors.map((one) => `${one}[data-nonce]`).join(', '));
  if (button) return button.dataset.nonce;

  if (editor) {
    // "Not there at all" and "there without a nonce" are different problems: the
    // first is a template that moved, the second a session without the right.
    const bare = editor.querySelector(selectors.join(', '));
    console.warn(
      bare
        ? `[wp-translator] ${editor.id}: "${action}" düğmesi var ama data-nonce taşımıyor.`
        : `[wp-translator] ${editor.id}: "${action}" düğmesi yok (${selectors.join(', ')}).`,
      editor.outerHTML.slice(0, 2000),
    );
  }
  return null;
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
  const found = /<tr[^>]*\bclass="[^"]*\bstatus-([a-z]+)/.exec(rendered);
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
        ? applyButton(row, judgement.proposal, judgement.proposalPlural)
        : Object.assign(document.createElement('div'), {
            className: 'wpt-expected',
            textContent: `önerilen: ${judgement.expected}`,
          }),
    );
  }
  // An untranslated row has no `.translation-text` to sit under, so the cell takes
  // the note instead. Without this a proposal is computed and never shown.
  const last = row.element.querySelectorAll('.translation-text');
  if (last.length > 0) last[last.length - 1].after(note);
  else row.element.querySelector('td.translation')?.append(note);
}

/**
 * The proposed wording, as a button that writes it into the row and saves it.
 *
 * Only a wording the server passed through the quality checks arrives here, and
 * only ever on a click: it replaces somebody else's pending submission.
 */
function applyButton(row, proposal, proposalPlural) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'wpt-apply';
  button.title = 'Bu çeviriyi satıra yaz ve kaydet';
  button.textContent = `önerilen: ${proposal}${proposalPlural ? ` / ${proposalPlural}` : ''}`;

  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const status = await applyProposal(row, proposal, proposalPlural);
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
async function applyProposal(row, proposal, proposalPlural) {
  const originalId = row.row.split('-')[0];
  const nonce = actionNonce(row.editor, 'save');
  if (!nonce) throw new Error('bu satırda kaydetme düğmesi yok — oturumun düzenleme yetkisi görünmüyor');

  // The id is digits, so the name needs no escaping inside the quoted value.
  const field = `translation[${originalId}][]`;
  const areas = [...row.editor.querySelectorAll(`textarea[name="${field}"]`)];
  const forms = proposalPlural ? [proposal, proposalPlural] : [proposal];
  if (areas.length !== forms.length) {
    // The request sends one value per field, so a mismatch would leave a form
    // empty — which is a translation the checks refuse.
    throw new Error(`${areas.length} çeviri alanı var, ${forms.length} karşılık verildi`);
  }
  areas.forEach((area, index) => (area.value = forms[index]));

  const body = new URLSearchParams({ original_id: originalId, _gp_route_nonce: nonce });
  for (const form of forms) body.append(field, form);

  const reply = await fetch(editorOptions(document).url ?? location.pathname, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: body.toString(),
  });
  const answer = await reply.text();
  if (!reply.ok) throw new Error(`${reply.status} ${reply.statusText} — ${answer.trim().slice(0, 200)}`);

  return savedStatus(answer);
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

/**
 * Judge the rows on the page in front of the reader, and nothing else.
 *
 * Only these rows can be annotated and ticked, so only these are asked about:
 * paging is the reader's, and a verdict nobody can see is work spent on a screen
 * that is not there. Whatever the page holds is worked through in batches, a few
 * at a time, each one annotated as its answer lands.
 */
async function run(panel, { approve }) {
  if (state.busy) return;
  reset();
  state.busy = true;

  try {
    // Split by what the row has, not by which queue it came from: `fuzzy` and
    // `either` hold both kinds, and only one of them can be judged.
    const rows = readRows(document);
    const batches = [];
    for (const kind of ['judge', 'propose']) {
      const mine = rows.filter((row) => (row.translation ? 'judge' : 'propose') === kind);
      for (let at = 0; at < mine.length; at += BATCH) batches.push(mine.slice(at, at + BATCH));
    }

    let next = 0;
    const lane = async (index) => {
      // Staggered so the lanes do not all reach the provider in the same instant.
      await pause(index * STAGGER_MS);
      while (next < batches.length && state.silent < SILENT_LIMIT) {
        await judgeBatch(panel, batches[next++], { approve, total: rows.length });
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(LANES, batches.length) }, (_, index) => lane(index)),
    );

    report(
      panel,
      state.counted < rows.length
        ? `${state.stopped} · kalan ${rows.length - state.counted} satır sorulmadı`
        : 'bitti',
    );
  } catch (problem) {
    report(panel, `hata: ${problem.message}`);
  } finally {
    state.busy = false;
  }
}

/**
 * One batch: ask, then act on each row it answered for.
 *
 * A batch holds rows of one kind. Rows carrying somebody's wording are judged;
 * rows carrying none are translated, and the answer arrives as a proposal to
 * apply — there is nothing to approve or tick on a string with no translation.
 */
async function judgeBatch(panel, slice, { approve, total }) {
  report(panel, `${state.counted + slice.length}/${total} soruluyor…`);
  const proposing = !slice[0].translation;

  let judgements;
  try {
    judgements = proposing
      ? await propose(slice)
      : (
          await ask('/api/judge', {
            projectPath: projectPath(),
            items: slice.map((row) => ({
              id: row.id,
              source: row.source,
              ...(row.sourcePlural ? { sourcePlural: row.sourcePlural } : {}),
              translation: row.translation,
              ...(row.translationPlural ? { translationPlural: row.translationPlural } : {}),
            })),
          })
        ).judgements;
  } catch (problem) {
    // One batch the tool could not answer is ten rows, not the page. They are
    // marked with the reason and the other lanes carry on.
    state.counted += slice.length;
    state.unknown += slice.length;
    state.failed += 1;
    state.silent += 1;
    state.stopped = 'sunucuya ulaşılamıyor';
    for (const row of slice) annotate(row, { verdict: 'unknown', reason: problem.message });
    report(panel, `${state.counted}/${total}`);
    return;
  }

  state.counted += slice.length;

  // A provider that is not answering costs the server its whole timeout per
  // batch and returns nothing, so the page would sit silent for minutes
  // rediscovering it. Two such batches in a row is enough to stop asking.
  if (judgements.every((judgement) => judgement.verdict === 'unknown')) {
    state.silent += 1;
    state.stopped = 'model yanıt vermiyor';
  } else {
    state.silent = 0;
  }

  for (const judgement of judgements) {
    const row = slice.find((candidate) => candidate.id === judgement.id);
    if (!row) continue;

    if (judgement.verdict === 'exact' && approve) {
      // One row the session cannot act on must not end the run; it is reported
      // where it happened and the rest go on.
      try {
        await setStatus(row, 'current');
        state.approved += 1;
      } catch (problem) {
        state.refused += 1;
        annotate(row, { verdict: 'unknown', reason: `onaylanamadı: ${problem.message}` });
      }
    } else if (judgement.verdict === 'exact' || judgement.verdict === 'agreed') {
      if (!tick(row)) state.unticked += 1;
      state.ticked += 1;
    } else if (judgement.verdict === 'flagged') {
      state.flagged += 1;
    } else if (judgement.verdict === 'proposed') {
      state.proposed += 1;
    } else {
      state.unknown += 1;
    }

    annotate(row, judgement);
  }
  report(panel, `${state.counted}/${total}`);
}

/**
 * Ask for a translation of rows that have none, as judgements the rest of the run
 * already knows how to show.
 *
 * `untranslated` is the verdict for one the tool could not translate; it is not a
 * failure of the run, and nothing is applied without a click either way.
 */
async function propose(slice) {
  const { proposals } = await ask('/api/propose', {
    ...ENGINE,
    projectPath: projectPath(),
    items: slice.map((row) => ({
      id: row.id,
      source: row.source,
      ...(row.sourcePlural ? { sourcePlural: row.sourcePlural } : {}),
    })),
  });

  return proposals.map((proposal) =>
    proposal.translation
      ? {
          id: proposal.id,
          verdict: 'proposed',
          reason: WHERE_FROM[proposal.from] ?? 'Öneri',
          expected: proposal.translation,
          proposal: proposal.translation,
          ...(proposal.translationPlural ? { proposalPlural: proposal.translationPlural } : {}),
        }
      : { id: proposal.id, verdict: 'unknown', reason: proposal.reason ?? 'Karşılık bulunamadı.' },
  );
}

const WHERE_FROM = {
  glossary: 'Sözlükteki karşılık — insan onaylı.',
  memory: 'Daha önce aynı dizge için verilen karşılık.',
  model: 'Model önerisi — kontrollerden geçti.',
};

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function report(panel, what) {
  panel.querySelector('.wpt-status').textContent =
    `${what} · ${state.counted} bakıldı · ${state.approved} onaylandı · ` +
    `${state.ticked} seçildi · ${state.flagged} işaretli · ` +
    (state.proposed ? `${state.proposed} öneri · ` : '') +
    `${state.unknown} kararsız` +
    (state.failed ? ` · ${state.failed} küme sorulamadı` : '') +
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
  return QUEUES.includes(status) ? status : null;
}

function mount() {
  const panel = document.createElement('div');
  panel.id = 'wpt-panel';
  panel.innerHTML = `
    <style>
      #wpt-panel { position: fixed; inset-block-end: 12px; inset-inline-end: 12px; z-index: 2147483647;
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
      .wpt-note[data-verdict="proposed"] { background: #172c1c; }
      .wpt-expected { color: #b9bec7; }
      .wpt-apply { display: block; margin-block-start: 4px; max-width: 100%; text-align: start;
        padding: 3px 6px; border: 1px solid #5a6472; border-radius: 4px; cursor: pointer;
        background: #1c2430; color: #e7e9ee; font: inherit; white-space: normal; }
      .wpt-apply:hover:not(:disabled) { border-color: #8ea2bd; }
      .wpt-apply[data-done="yes"] { border-color: #2f7d4f; cursor: default; }
    </style>
    <b>wp-translator</b>
    <div>
      <button data-act="dry" title="Bu sayfadaki satırları değerlendirir, hiçbir şeyi değiştirmez">Bu sayfayı değerlendir</button>
      <button data-act="live" title="Bu sayfayı değerlendirir ve sözlükle birebir eşleşenleri onaylar">Değerlendir ve birebir olanları onayla</button>
    </div>
    <span class="wpt-status">hazır</span>
  `;
  document.body.append(panel);

  const filter = pendingFilter();
  const rows = readRows(document).length;
  const dry = panel.querySelector('[data-act="dry"]');
  const live = panel.querySelector('[data-act="live"]');

  if (!filter) {
    // Not a dead end: pressing goes to the queue rather than leaving the reader to
    // edit the address by hand, which is what a disabled button asked of them.
    dry.textContent = 'Bekleyen kuyruğuna git';
    live.remove();
    dry.addEventListener('click', () => {
      const url = new URL(location.href);
      url.searchParams.set('filters[status]', 'waiting');
      location.href = url.toString();
    });
    say(panel, 'Bu sayfada bekleyen kuyruğu yok.');
    return;
  }

  if (rows === 0) {
    for (const button of panel.querySelectorAll('button')) button.disabled = true;
    say(panel, `Bu sayfada "${filter}" için okunacak satır yok. GTE olarak giriş yapılı mı?`);
    return;
  }

  say(panel, `hazır · ${filter} · bu sayfada ${rows} satır`);
  void reachable(panel, filter, rows);
  dry.addEventListener('click', () => void run(panel, { approve: false }));
  live.addEventListener('click', () => {
    if (confirm('Bu sayfada sözlükle birebir eşleşenler doğrudan onaylanacak. Devam edilsin mi?')) {
      void run(panel, { approve: true });
    }
  });

  // A panel that is there but inert looks the same as one whose clicks are being
  // swallowed by something above it, so the console says which it is.
  const box = dry.getBoundingClientRect();
  const onTop = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  if (onTop !== dry && !dry.contains(onTop)) {
    console.warn(
      '[wp-translator] düğmenin üstünde başka bir öge var, tıklamalar ona gidiyor:',
      onTop && `${onTop.tagName}.${onTop.className}`,
    );
  }
}

/**
 * Check the local tool answers, before the reader presses anything.
 *
 * Otherwise an unreachable server or a refused permission first shows itself part
 * way through a run, looking like a failure of the run.
 */
async function reachable(panel, filter, rows) {
  try {
    // `/api/health` on purpose: a judging request would reach the model, and a
    // page load must not spend one.
    await ask('/api/health', undefined, 'GET');
  } catch (problem) {
    say(panel, `hazır değil · ${problem.message}`);
    for (const button of panel.querySelectorAll('button')) button.disabled = true;
    return;
  }
  say(panel, `hazır · ${filter} · bu sayfada ${rows} satır`);
}

/** The panel's one line of state, also echoed to the console. */
function say(panel, what) {
  panel.querySelector('.wpt-status').textContent = what;
  console.info('[wp-translator]', what);
}

// Announced so a page with the script loaded can be told from one without it.
console.info('[wp-translator] yüklendi', location.pathname, pendingFilter() ?? '(filtresiz)');
mount();
