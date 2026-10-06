// ==UserScript==
// @name         wp-translator · %100 bellek eşleşmelerini onayla
// @namespace    https://github.com/turker/wp-translator
// @version      1.0.0
// @description  Bekleyen ve fuzzy girdisi olan eklentileri sırayla gezer; GlotPress'in çeviri belleği %100 skorla aynı karşılığı veriyorsa onaylar, başka bir karşılık veriyorsa onu yazar, yerelleştirilemeyen eklentilerin satırlarını reddeder.
// @match        https://translate.wordpress.org/locale/tr/default/wp-plugins/*
// @match        https://translate.wordpress.org/projects/wp-plugins/*/tr/default/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

'use strict';

/**
 * A walk over translate.wordpress.org's pending queues, settling the rows that
 * GlotPress's own translation memory already answers at a 100% score.
 *
 * Three things happen to a row, and the memory decides which:
 *
 * - the memory's wording and the submitted one are identical — **approve**;
 * - they differ — **save** the memory's own wording, which as a GTE makes it the
 *   current translation and keeps the submission in the history;
 * - the plugin has no code project at all, so nothing translated in it can ever
 *   ship — **reject** every pending row, memory or no memory.
 *
 * Nothing is written through an API: the suggestions are the ones GlotPress loads
 * into the open editor, and every write is its own button being pressed. The run
 * therefore needs a logged-in session and has exactly the rights that session has.
 */

/** Where the walk starts, and the ordering that makes it worth walking. */
const LISTING = 'https://translate.wordpress.org/locale/tr/default/wp-plugins/';
const LISTING_FILTER = 'strings-waiting-and-fuzzy-asc';

/** The run, in the tab that is doing it. Another translate.wordpress.org tab is left alone. */
const STATE_KEY = 'wpt-tm-run';

/**
 * What the translation memory answered for a source string, kept across pages.
 *
 * The memory is a property of the locale, not of the project, so the same string
 * in the next plugin is the same answer — and a plugin queue is mostly strings
 * every other plugin also has. Keyed on the source text alone: `msgctxt` is not
 * what the memory is asked about.
 */
const CACHE_KEY = 'wpt-tm-cache';
const CACHE_LIMIT = 20_000;

/** Pacing. translate.wordpress.org rate-limits a tight loop and sends no `Retry-After`. */
const ROW_PAUSE_MS = 600;
const HOP_PAUSE_MS = 1_500;
const FETCH_PAUSE_MS = 800;

/** Given to the page's own scripts before a row is opened. */
const SETTLE_MS = 1_500;

/** How long an opened row is given to produce suggestions, and a press to produce a status. */
const SUGGESTION_WAIT_MS = 20_000;
/** How long the answer is waited for before the sidebar's own tab is pressed as well. */
const NUDGE_AFTER_MS = 4_000;
const APPROVE_WAIT_MS = 20_000;

/**
 * How many times one filter page is worked before the walk moves on regardless.
 *
 * Approving pulls rows from the next page onto this one, so a page that approved
 * something is worked again. A row that reports approval without leaving the
 * queue would otherwise be worked for ever.
 */
const PASS_LIMIT = 20;

/**
 * How many listing pages a dry run takes, and therefore how far it walks.
 *
 * A dry run is there to show that the memory answers and that the comparison
 * picks the right rows, which the first plugins say; walking the whole listing to
 * decide nothing is days of pages. A live run takes the listing whole.
 */
const DRY_LIST_PAGES = 2;

/** The sub-projects, and which of them a plugin's work is taken from. */
const SET_KINDS = ['dev', 'dev-readme', 'stable', 'stable-readme'];
const PREFERRED = ['dev', 'dev-readme'];
const FALLBACK = ['stable', 'stable-readme'];

/** Where GlotPress puts the memory's answer inside an opened row. */
const MEMORY_CONTAINER = '.sidebar-div-others-translation-memory-content';

/** Pressed in this order; the first that exists is the one pressed. */
const APPROVE_SELECTORS = ['.inline-action-approve', 'button.approve', 'a.action.approve'];
/**
 * Rejection is the row's own inline button and nothing else.
 *
 * `gp-translation-helpers/js/reject-feedback.js` puts a feedback modal in front of
 * the **bulk** reject, and the editor's own reject button sits inside that
 * feedback form — pressing either would wait for a dialog nobody is going to
 * fill. A row without the inline button is reported instead.
 */
const REJECT_SELECTORS = ['.inline-action-reject'];
/** translate.wordpress.org renames GlotPress's save button; both spellings are accepted. */
const SAVE_SELECTORS = ['button.translation-actions__save', 'button.ok'];

/**
 * The notice that says a plugin's strings can never ship, and what it means.
 *
 * `wporg-gp-customizations/templates/locale-project.php` renders it when the
 * project has neither a `dev` nor a `stable` sub-project, so the sub-project list
 * says the same thing the sentence does — the walk reads both and says so when
 * they disagree, because only one of them is the owner's instruction.
 */
const BROKEN_NOTICE = '.wporg-notice-error';
const BROKEN_TEXT = /properly prepared for localization/i;
const CODE_KINDS = ['dev', 'stable'];

/** Set by the stop button, read between rows: the page is mid-walk when it is pressed. */
let halted = false;

// ───────────────────────── decisions, free of the page ─────────────────────────

/** Which kind of page this is, by path alone — the walk resumes from whatever loaded. */
function place(pathname) {
  if (/^\/locale\/tr\/default\/wp-plugins\/?$/.test(pathname)) return 'listing';
  if (/^\/locale\/tr\/default\/wp-plugins\/[^/]+\/$/.test(pathname)) return 'plugin';
  if (/^\/projects\/wp-plugins\/[^/]+\/[^/]+\/tr\/default\/$/.test(pathname)) return 'set';
  return 'other';
}

/** The plugin slug in either kind of path. */
function slugOf(pathname) {
  const found =
    /^\/locale\/tr\/default\/wp-plugins\/([^/]+)\//.exec(pathname) ??
    /^\/projects\/wp-plugins\/([^/]+)\//.exec(pathname);
  return found ? found[1] : '';
}

/** Which sub-project a translation-set path belongs to, or null for one we do not walk. */
function setKind(pathname) {
  const found = /^\/projects\/wp-plugins\/[^/]+\/([^/]+)\//.exec(pathname);
  return found && SET_KINDS.includes(found[1]) ? found[1] : null;
}

/**
 * The sub-projects to work, in order.
 *
 * Development is where a plugin's current strings live, so where it has one, it
 * and its readme are the work. A plugin with no development project at all is
 * worked from stable instead — the alternative is walking past it.
 */
function chooseSets(kinds) {
  const wanted = kinds.includes('dev') ? PREFERRED : FALLBACK;
  return wanted.filter((kind) => kinds.includes(kind));
}

/** "1,234" as a number, and anything unreadable as 0. */
function countOf(text) {
  const digits = (text ?? '').replace(/[^\d]/g, '');
  return digits ? Number(digits) : 0;
}

/** "100%" as 100. A suggestion with no score is not a scored suggestion. */
function parseScore(text) {
  const found = /(\d+)\s*%/.exec(text ?? '');
  return found ? Number(found[1]) : null;
}

/**
 * The wordings the memory offered for *this* string, and no others.
 *
 * The score is the similarity of the **source** string, not of the translation:
 * a 95% suggestion is a translation of a different English string that happens
 * to resemble this one, and its wording says nothing about this one. Only 100%
 * is this string being answered.
 */
function hundredPercent(suggestions) {
  return suggestions.filter((one) => one.score === 100).map((one) => one.text);
}

/**
 * Whether the memory holds this exact wording.
 *
 * Character for character, with no folding of case or edge whitespace: the
 * alternatives are separate memory entries for a reason, and a trailing space is
 * a difference GlotPress's own checks are watching.
 */
function isExactMatch(wordings, translation) {
  return wordings.some((one) => one === translation);
}

// ───────────────────────────── the run's state ─────────────────────────────

function blank(mode) {
  return {
    running: true,
    mode,
    phase: 'collect',
    broken: false,
    brokenSlug: '',
    stuck: [],
    listPage: 1,
    lastListPage: 0,
    plugins: [],
    at: 0,
    visited: [],
    targets: [],
    target: 0,
    passes: 0,
    note: '',
    counts: {
      plugins: 0,
      sets: 0,
      rows: 0,
      asked: 0,
      cached: 0,
      matched: 0,
      approved: 0,
      saved: 0,
      rejected: 0,
      unconfirmed: 0,
      plural: 0,
      failed: 0,
    },
  };
}

function read() {
  try {
    const kept = sessionStorage.getItem(STATE_KEY);
    return kept ? JSON.parse(kept) : null;
  } catch {
    // A private window or blocked site data: there is simply no run to resume.
    return null;
  }
}

function write(state) {
  try {
    sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // Not fatal while the page lasts; the next load starts over.
  }
}

function clear() {
  try {
    sessionStorage.removeItem(STATE_KEY);
  } catch {
    // Nothing to do: there is no run either way.
  }
}

// ───────────────────────────── the memory cache ─────────────────────────────

function cacheAll() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

/** The wordings remembered for a source string, or null when it has never been asked. */
function cacheRead(source) {
  const all = cacheAll();
  return Object.hasOwn(all, source) ? all[source] : null;
}

function cacheWrite(source, wordings) {
  const all = cacheAll();
  all[source] = wordings;
  const keys = Object.keys(all);
  // Oldest first by insertion order, which is what `Object.keys` gives back.
  if (keys.length > CACHE_LIMIT) for (const key of keys.slice(0, keys.length - CACHE_LIMIT)) delete all[key];
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch {
    // Full or blocked: the run goes on asking GlotPress instead.
  }
}

// ───────────────────────────── reading a page ─────────────────────────────

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
      // Not fatal: the walk only reads a right out of it.
    }
  }
  return {};
}

/** Whether this session may approve here. Empty for anonymous and for a plain translator. */
function mayApprove(root) {
  if (editorOptions(root).can_approve) return true;
  return Boolean(root.querySelector('.inline-action-approve, #translations button.approve'));
}

/** The plugin slugs on a listing page, skipping any the listing says has nothing pending. */
function slugsOn(root) {
  const slugs = [];
  for (const project of root.querySelectorAll('#projects .project')) {
    const link = project.querySelector('a[href*="/locale/tr/default/wp-plugins/"]');
    const slug = link ? slugOf(new URL(link.getAttribute('href'), LISTING).pathname) : '';
    if (!slug) continue;
    const pending = countOf(project.querySelector('.project-status-waiting .project-status-value')?.textContent);
    if (pending > 0) slugs.push(slug);
  }
  return slugs;
}

/** The highest page number a paging block links to. */
function lastPage(root) {
  let highest = 1;
  for (const link of root.querySelectorAll('.paging a[href*="page="]')) {
    const page = Number(new URL(link.getAttribute('href'), LISTING).searchParams.get('page'));
    if (Number.isFinite(page) && page > highest) highest = page;
  }
  return highest;
}

/**
 * The filter pages to work for one plugin.
 *
 * The URLs are the ones the plugin page's own table links to, counts and all, so
 * a sub-project with nothing waiting costs no page load and the filter is spelled
 * the way GlotPress spells it rather than the way this script guesses.
 */
function targetsFrom(root, { all = false } = {}) {
  const found = new Map();
  for (const row of root.querySelectorAll('table.locale-sub-projects tbody tr')) {
    const link = row.querySelector('td.set-name a[href]');
    if (!link) continue;
    const kind = setKind(new URL(link.getAttribute('href'), location.origin).pathname);
    if (!kind) continue;
    found.set(kind, {
      waiting: queue(row, 'waiting'),
      fuzzy: queue(row, 'fuzzy'),
    });
  }

  const targets = [];
  const kinds = all ? SET_KINDS.filter((kind) => found.has(kind)) : chooseSets([...found.keys()]);
  for (const kind of kinds) {
    for (const status of ['waiting', 'fuzzy']) {
      const one = found.get(kind)[status];
      if (one) targets.push({ url: one.url, label: `${kind} · ${status} · ${one.count}` });
    }
  }
  return targets;
}

function queue(row, status) {
  const link = row.querySelector(`td.stats.${status} a[href]`);
  const count = countOf(link?.textContent);
  return link && count > 0
    ? { url: new URL(link.getAttribute('href'), location.origin).toString(), count }
    : null;
}

/**
 * Whether a plugin's sub-projects say its strings can never ship.
 *
 * An empty list is not an answer: a page whose table could not be read says
 * nothing about the plugin, and claiming otherwise would reject it.
 */
function noCodeProject(kinds) {
  return kinds.length > 0 && !CODE_KINDS.some((kind) => kinds.includes(kind));
}

/**
 * Whether this plugin page says the plugin cannot be localised at all.
 *
 * The sentence is the owner's instruction, and the sub-project list is the
 * condition the template renders it on. A page where those two disagree is a
 * template that has moved, which is worth a line in the console rather than a
 * silent guess either way.
 */
function brokenPlugin(root) {
  const notice = [...root.querySelectorAll(`${BROKEN_NOTICE} p`)].some((one) =>
    BROKEN_TEXT.test(one.textContent ?? ''),
  );
  const kinds = [...root.querySelectorAll('table.locale-sub-projects td.set-name a[href]')]
    .map((link) => setKind(new URL(link.getAttribute('href'), location.origin).pathname))
    .filter(Boolean);
  const noCode = noCodeProject(kinds);

  if (notice !== noCode) {
    console.warn(
      '[wpt-tm] bildirim ve alt proje listesi aynı şeyi söylemiyor:',
      `bildirim=${notice}`,
      `kod projesi=${!noCode}`,
      kinds.join(', '),
    );
  }
  return notice;
}

/**
 * Every pending row on a translation-set page.
 *
 * Both strings are read off the editor row, which is rendered with the page and
 * needs no opening: `span.original-raw` and the textarea's value are the strings
 * themselves, while the preview cells draw them — a glossary term is wrapped in a
 * span there and an invisible character is drawn as a marker.
 */
function readRows(root) {
  const rows = [];
  for (const preview of root.querySelectorAll('#translations tr.preview[row]')) {
    const id = preview.getAttribute('row');
    const originalId = Number(id.split('-')[0]);
    if (!Number.isFinite(originalId) || originalId === 0) continue;
    // A row that is already current is one this walk, or somebody else, has
    // settled since the page was rendered.
    if (!/\bstatus-(waiting|fuzzy)\b/.test(preview.className)) continue;

    const editor = root.getElementById(`editor-${id}`);
    if (!editor) continue;
    const areas = [...editor.querySelectorAll(`textarea[name="translation[${originalId}][]"]`)];
    rows.push({
      id,
      originalId,
      /** Null on a row with no translation; `-set-status/` names this one. */
      translationId: Number(id.split('-')[1]) || null,
      source: editor.querySelector('.original-raw')?.textContent ?? '',
      /** One per plural form. The memory answers the singular, so only a single form is worked. */
      forms: areas.length,
      translation: areas.length === 1 ? areas[0].value : '',
      element: preview,
      editor,
    });
  }
  return rows;
}

/**
 * The scored suggestions the translation memory has put in an open editor, or null
 * until they arrive.
 *
 * Scoped to the memory's own container rather than to the class, because the
 * editor's sidebar renders other sources with the same `.translation-suggestion`
 * class from requests of their own: one of those arriving first, read as the
 * memory's answer, would be cached as "the memory offers nothing" for every later
 * plugin holding that string. An empty container is an answer that has not landed
 * yet; only `.no-suggestions` is the memory saying it has none.
 *
 * The raw span carries the wording; the visible one is marked up.
 */
function suggestionsIn(editor) {
  const home = editor.querySelector(MEMORY_CONTAINER) ?? editor;
  if (home.querySelector('.no-suggestions')) return [];

  const nodes = [...home.querySelectorAll('.translation-suggestion')];
  if (nodes.length === 0) return null;

  const mine = nodes.filter((node) => (node.dataset.suggestionSource ?? 'tm') === 'tm');
  return mine.map((node) => ({
    score: parseScore(node.querySelector('.translation-suggestion__score')?.textContent),
    text:
      node.querySelector('.translation-suggestion__translation-raw')?.textContent ??
      node.querySelector('.translation-suggestion__translation')?.textContent ??
      '',
  }));
}

// ──────────────────── what the page's own requests answered ────────────────────

/**
 * The last few requests the page made, so a refusal can be read rather than waited
 * out.
 *
 * Every write is GlotPress's own button pressing GlotPress's own request, so the
 * answer belongs to the page and not to this script. Without listening, a refusal
 * and a slow answer look alike for the whole timeout and neither says why. The
 * listening only ever *shortens a failure*: success is still the row's status,
 * because what a 200 means is GlotPress's business and not something to guess.
 */
const TRAFFIC = [];
const TRAFFIC_LIMIT = 20;

function recall(one) {
  TRAFFIC.push({ ...one, at: Date.now() });
  if (TRAFFIC.length > TRAFFIC_LIMIT) TRAFFIC.shift();
}

/**
 * Wrap the page's own request plumbing.
 *
 * This works because the script is granted nothing and therefore runs in the
 * page's own context; where a manager puts it in a sandbox the wrapping does not
 * take, the walk falls back to waiting for the row's status, and the console says
 * which of the two it is.
 */
function listen() {
  const xhr = window.XMLHttpRequest?.prototype;
  if (!xhr || xhr.wptWatched) return Boolean(xhr?.wptWatched);

  const opened = xhr.open;
  const sent = xhr.send;
  xhr.open = function (method, url, ...rest) {
    this.wptUrl = String(url ?? '');
    return opened.call(this, method, url, ...rest);
  };
  xhr.send = function (body) {
    this.wptBody = typeof body === 'string' ? body : '';
    this.addEventListener('loadend', () => {
      // Reading `responseText` throws unless the response was asked for as text.
      const text = this.responseType === '' || this.responseType === 'text'
        ? String(this.responseText ?? '')
        : '';
      recall({ url: this.wptUrl, body: this.wptBody, status: this.status, text: text.slice(0, 600) });
    });
    return sent.call(this, body);
  };
  xhr.wptWatched = true;

  const fetched = window.fetch;
  if (typeof fetched === 'function' && !fetched.wptWatched) {
    const watched = async (input, init) => {
      const url = typeof input === 'string' ? input : (input?.url ?? '');
      const body = typeof init?.body === 'string' ? init.body : '';
      const reply = await fetched(input, init);
      reply
        .clone()
        .text()
        .then(
          (text) => recall({ url, body, status: reply.status, text: text.slice(0, 600) }),
          () => {},
        );
      return reply;
    };
    watched.wptWatched = true;
    window.fetch = watched;
  }
  return true;
}

/** Whether a request's body names this id under this field, and not one starting with it. */
function carries(body, field, id) {
  return new RegExp(`(^|&)${field}=${id}(&|$)`).test(body ?? '');
}

/**
 * The reason a write was refused, if one of the page's requests has said so since
 * the button was pressed.
 *
 * A non-200 is a refusal whatever it says. A 200 is only a refusal where the body
 * says so itself — GlotPress answers `{"success":false, …}` and its own `error`
 * where it has something to report.
 */
function refusal(since, matches) {
  for (const one of TRAFFIC) {
    if (one.at < since || !matches(one)) continue;
    if (one.status !== 200) return `${one.status} ${one.text.trim().slice(0, 200)}`.trim();
    const said = complaint(one.text);
    if (said) return said;
  }
  return null;
}

function complaint(text) {
  try {
    const data = JSON.parse(text);
    if (data?.success === false) return typeof data.data === 'string' ? data.data.slice(0, 200) : 'istek reddedildi';
    if (typeof data?.error === 'string') return data.error.slice(0, 200);
    if (typeof data?.error_message === 'string') return data.error_message.slice(0, 200);
  } catch {
    // Not JSON. GlotPress answers HTML when it answers at all, and an HTML 200 is
    // not something to read a refusal out of.
  }
  return null;
}

/** The request a status write makes for this row, and the one a save makes. */
const statusWrite = (row) => (one) =>
  one.url.includes('-set-status/') && carries(one.body, 'translation_id', row.translationId);
const saveWrite = (row) => (one) => carries(one.body, 'original_id', row.originalId);

// ───────────────────────────── the walk ─────────────────────────────

async function resume(state) {
  const here = place(location.pathname);

  if (state.phase === 'collect') {
    if (here !== 'listing') return hop(state, listingUrl(state.listPage));
    return collect(state);
  }

  if (here === 'plugin') return openPlugin(state);
  if (here === 'set') return workSet(state);
  // Running, but somewhere the walk did not send itself. Put it back on its feet
  // rather than stopping: a redirect to a login page or a project's front page is
  // what this looks like.
  return nextPlugin(state, 'beklenmeyen bir sayfa açıldı, sıradaki eklentiye geçiliyor');
}

/**
 * Collect every plugin slug before approving anything.
 *
 * The listing is sorted ascending by what is waiting, so every approval moves a
 * plugin in it and shifts the ones behind. Walking the listing live and following
 * its paging would skip whatever crossed a page boundary while the walk was
 * working; the list is therefore taken first and the walk follows its own copy.
 */
async function collect(state) {
  for (;;) {
    if (halted) return;
    say(`eklenti listesi toplanıyor · sayfa ${state.listPage}${state.lastListPage ? `/${state.lastListPage}` : ''} · ${state.plugins.length} eklenti`);

    let doc;
    try {
      doc = await load(listingUrl(state.listPage));
    } catch (problem) {
      return stop(state, `eklenti listesi alınamadı: ${problem.message}`);
    }

    if (state.lastListPage === 0) {
      state.lastListPage =
        state.mode === 'dry' ? Math.min(lastPage(doc), DRY_LIST_PAGES) : lastPage(doc);
    }
    const known = new Set(state.plugins);
    for (const slug of slugsOn(doc)) {
      if (known.has(slug)) continue;
      known.add(slug);
      state.plugins.push(slug);
    }
    write(state);

    if (state.listPage >= state.lastListPage) break;
    state.listPage += 1;
    write(state);
    await pause(FETCH_PAUSE_MS);
  }

  state.phase = 'walk';
  state.at = 0;
  write(state);
  if (state.plugins.length === 0) return stop(state, 'listede bekleyen girdisi olan eklenti yok');
  return hop(state, pluginUrl(state.plugins[0]));
}

/** On a plugin's page: read what kind of plugin it is, pick its queues, go to the first. */
function openPlugin(state) {
  const slug = slugOf(location.pathname) || state.plugins[state.at];
  if (!state.visited.includes(slug)) state.visited.push(slug);
  state.counts.plugins += 1;

  // A plugin with no code project has only readme projects, and "every pending
  // row" means both of them — the usual dev-or-stable choice would leave one.
  state.broken = brokenPlugin(document);
  // Kept with the slug it was read from, because rejecting is decided on a page
  // the row is not on.
  state.brokenSlug = state.broken ? slug : '';
  state.targets = targetsFrom(document, { all: state.broken });
  state.target = 0;
  state.passes = 0;
  write(state);

  if (state.targets.length === 0) return nextPlugin(state, `${slug}: bekleyen alt proje yok`);
  say(`${slug} · ${state.targets.length} kuyruk${state.broken ? ' · yerelleştirilemeyen eklenti, reddedilecek' : ''}`);
  return hop(state, pageOf(state.targets[0].url, 1));
}

/**
 * Work one filter page: ask the memory about each row, approve the ones it already
 * holds word for word.
 */
async function workSet(state) {
  // GlotPress binds the row's own click handler on its own schedule, and opening
  // a row before that does nothing at all — which reads as a memory that never
  // answers.
  await pause(SETTLE_MS);
  if (state.mode === 'live' && !mayApprove(document)) {
    return stop(state, 'bu oturum onaylayamıyor — GTE olarak giriş yapılı mı?');
  }

  // The rejection was decided on the plugin's own page; a queue belonging to any
  // other plugin is not what it was decided about.
  if (state.broken && state.brokenSlug !== slugOf(location.pathname)) {
    console.warn('[wpt-tm] red kararı başka bir eklentiye ait, yok sayılıyor:', state.brokenSlug);
    state.broken = false;
    write(state);
  }

  const rows = readRows(document);
  const label = state.targets[state.target]?.label ?? setKind(location.pathname) ?? '';
  let settledHere = 0;

  for (const [index, row] of rows.entries()) {
    if (halted) return;
    say(`${slugOf(location.pathname)} · ${label} · ${index + 1}/${rows.length}`);
    if (await handleRow(state, row)) settledHere += 1;
    write(state);
  }

  report(state, `${label} · ${rows.length} satır bitti`);

  // Approving, saving and rejecting all take the row out of the queue and pull the
  // next page's rows onto this one, so this page is worked again before the walk
  // moves forward.
  if (settledHere > 0 && state.passes < PASS_LIMIT) {
    state.passes += 1;
    write(state);
    await pause(HOP_PAUSE_MS);
    return location.reload();
  }

  state.passes = 0;
  const next = document.querySelector('.gp-table-actions .paging a.next[href]');
  if (next) return hop(state, new URL(next.getAttribute('href'), location.origin).toString());
  return nextTarget(state);
}

/**
 * One row: what is to be done with it, and — only in a live run — the button that
 * does it. True when the row left the queue, which is what sends the walk over
 * this page again.
 */
async function handleRow(state, row) {
  state.counts.rows += 1;

  // A write that did not take is not tried again while the walk is on this queue.
  // A save that GlotPress stored as `waiting` leaves the submission pending, so
  // the next pass over the page would save the same wording again, and again.
  if (state.stuck.includes(row.originalId)) return false;

  // Nothing in this plugin can ever ship, so the memory is not consulted: the
  // wording, the plural forms and the score are all beside the point.
  if (state.broken) {
    if (state.mode !== 'live') {
      annotate(row, 'red', 'yerelleştirilemeyen eklenti — reddedilecekti');
      return false;
    }
    const gone = await press(row, REJECT_SELECTORS, 'status-rejected', statusWrite);
    await pause(ROW_PAUSE_MS);
    if (gone.ok) {
      state.counts.rejected += 1;
      annotate(row, 'red', 'yerelleştirilemeyen eklenti — reddedildi');
      return true;
    }
    state.counts.unconfirmed += 1;
    state.stuck.push(row.originalId);
    annotate(row, 'sorun', `reddedilemedi: ${gone.why}`);
    return false;
  }

  if (row.forms !== 1) {
    // The memory answers a singular string. Writing a plural row off its
    // singular half settles a form nobody looked at.
    state.counts.plural += 1;
    return false;
  }
  if (!row.source) return false;

  const wordings = await remember(state, row);
  if (wordings === null) return false;
  if (wordings.length === 0) return false;

  if (isExactMatch(wordings, row.translation)) {
    state.counts.matched += 1;
    if (state.mode !== 'live') {
      annotate(row, 'eslesme', '%100 bellek eşleşmesi — onaylanacaktı');
      return false;
    }
    const confirmed = await press(row, APPROVE_SELECTORS, 'status-current', statusWrite);
    await pause(ROW_PAUSE_MS);
    if (confirmed.ok) {
      state.counts.approved += 1;
      annotate(row, 'onay', '%100 bellek eşleşmesi — onaylandı');
      return true;
    }
    state.counts.unconfirmed += 1;
    state.stuck.push(row.originalId);
    annotate(row, 'sorun', `onaylanamadı: ${confirmed.why}`);
    return false;
  }

  // The memory answers this string but with another wording. The first of its
  // 100% suggestions is the one GlotPress itself puts at the top.
  const wording = wordings[0];
  if (state.mode !== 'live') {
    annotate(row, 'kaydet', `bellekteki karşılık yazılacaktı: ${wording}`);
    return false;
  }
  const saved = await save(row, wording);
  await pause(ROW_PAUSE_MS);
  if (saved.ok) {
    state.counts.saved += 1;
    annotate(row, 'kaydet', `bellekteki karşılık yazıldı: ${wording}`);
    return true;
  }
  state.counts.unconfirmed += 1;
  state.stuck.push(row.originalId);
  annotate(row, 'sorun', `yazılamadı (${saved.why}): ${wording}`);
  return false;
}

/**
 * The memory's 100% wordings for this row's source, from the cache or from
 * GlotPress, in the order GlotPress offered them.
 *
 * Null is "the answer never came", which is reported on the row and settles
 * nothing; an empty list is the memory saying it has none.
 */
async function remember(state, row) {
  const kept = cacheRead(row.source);
  if (kept) {
    state.counts.cached += 1;
    return kept;
  }

  const suggestions = await suggestionsFor(row);
  if (suggestions === null) {
    state.counts.failed += 1;
    annotate(row, 'sorun', 'çeviri belleği yanıt vermedi');
    return null;
  }
  const wordings = hundredPercent(suggestions);
  cacheWrite(row.source, wordings);
  state.counts.asked += 1;
  await pause(ROW_PAUSE_MS);
  return wordings;
}

/**
 * What the memory says about this row, by opening the row GlotPress loads it for.
 *
 * The request GlotPress makes carries a nonce minted for the session, and nothing
 * on an anonymous page shows where that nonce is put — so the request is left to
 * GlotPress and only its answer is read. One open per *string*, not per row: the
 * cache is what keeps the next plugin's "Delete" from being asked again.
 */
async function suggestionsFor(row) {
  open(row);
  let found = await until(() => suggestionsIn(row.editor), NUDGE_AFTER_MS);
  if (found === null) {
    // The sidebar's own tab is where the memory's answer lands, and the markup
    // ships it hidden. Opening the row is enough on translate.wordpress.org, so
    // this is insurance rather than the path: pressing a tab that is already
    // showing changes nothing.
    row.editor.querySelector('.sidebar-tabs .tab-others')?.click();
    found = await until(() => suggestionsIn(row.editor), SUGGESTION_WAIT_MS - NUDGE_AFTER_MS);
  }
  if (found === null) complain(row);
  close(row);
  return found;
}

/**
 * Report the first row whose answer never landed, with the row itself.
 *
 * Nothing inside `tr.editor` can be checked without a logged-in session, so this
 * is where a container that has moved shows itself — once, because the walk sees
 * hundreds of rows.
 */
let complained = false;
function complain(row) {
  if (complained) return;
  complained = true;
  console.warn(
    '[wpt-tm] çeviri belleği yanıtı bulunamadı; satırın HTML’i:',
    row.id,
    row.editor.outerHTML.slice(0, 4000),
  );
}

function open(row) {
  const details = row.element.querySelector('td.actions a.action.edit');
  if (details) details.click();
  else row.element.click();
}

function close(row) {
  row.editor.querySelector('.panel-header-actions__cancel')?.click();
}

/**
 * Press one of GlotPress's own buttons and wait for the row to say it happened.
 *
 * Pressing is not doing: GlotPress answers its own request, and a row with
 * warnings or a session without the right comes back unchanged. The status on the
 * row is the only thing that says otherwise.
 */
async function press(row, selectors, status, matches) {
  const button = selectors
    .map((selector) => row.element.querySelector(selector) ?? row.editor.querySelector(selector))
    .find(Boolean);

  if (!button) {
    console.warn(
      `[wpt-tm] düğme yok (${selectors.join(', ')}):`,
      row.id,
      row.element.outerHTML.slice(0, 1000),
    );
    return { ok: false, why: `düğme yok (${selectors.join(', ')})` };
  }
  const since = Date.now();
  button.click();
  return settled(row, status, since, matches(row));
}

/**
 * Write the memory's wording into the row and press save.
 *
 * Saving is the editor's, not an inline action, so the row has to be open for the
 * field to be there. As a GTE the save lands as the current translation and keeps
 * the submission it replaces in the history — which is what correcting somebody's
 * wording in place should do.
 */
async function save(row, wording) {
  open(row);
  const area = await until(
    () => row.editor.querySelector(`textarea[name="translation[${row.originalId}][]"]`),
    SETTLE_MS * 4,
  );
  if (!area) {
    console.warn('[wpt-tm] çeviri alanı bulunamadı:', row.id);
    return { ok: false, why: 'çeviri alanı bulunamadı' };
  }

  area.value = wording;
  // GlotPress watches the field to enable its own save button and to size the box.
  area.dispatchEvent(new Event('input', { bubbles: true }));
  area.dispatchEvent(new Event('change', { bubbles: true }));

  const button = SAVE_SELECTORS.map((selector) => row.editor.querySelector(selector)).find(Boolean);
  if (!button) {
    console.warn(
      `[wpt-tm] kaydet düğmesi yok (${SAVE_SELECTORS.join(', ')}):`,
      row.id,
      row.editor.outerHTML.slice(0, 2000),
    );
    close(row);
    return { ok: false, why: `kaydet düğmesi yok (${SAVE_SELECTORS.join(', ')})` };
  }
  const since = Date.now();
  button.click();

  const done = await settled(row, 'status-current', since, saveWrite(row));
  close(row);
  return done;
}

/**
 * Wait for the string's row to carry a status, and stop early if the page's own
 * request has already been refused.
 *
 * A save makes a *new* translation, so GlotPress renders the row back under a new
 * `<originalId>-<translationId>`; watching the old one would read every save as a
 * row that never changed. The status is the only thing that says a write took —
 * the refusal is only what spares the walk the whole timeout, and says why.
 */
async function settled(row, status, since, matches) {
  const wanted = new RegExp(`\\b${status}\\b`);
  const answer = await until(() => {
    const pair = rowsFor(row.originalId);
    // A row GlotPress has taken off the page is a row that left the queue.
    if (pair.length === 0) return { ok: true };
    if (pair.some((one) => wanted.test(one.className))) return { ok: true };
    const why = refusal(since, matches);
    return why ? { ok: false, why } : null;
  }, APPROVE_WAIT_MS);

  return answer ?? { ok: false, why: `${APPROVE_WAIT_MS / 1000} saniyede durumu değişmedi` };
}

/** Both of a string's rows, however its translation is numbered now. */
function rowsFor(originalId) {
  return [...document.querySelectorAll('#translations tr[row]')].filter(
    (one) => (one.getAttribute('row') ?? '').split('-')[0] === String(originalId),
  );
}

function nextTarget(state) {
  state.counts.sets += 1;
  state.target += 1;
  state.passes = 0;
  state.stuck = [];
  write(state);
  if (state.target < state.targets.length) return hop(state, pageOf(state.targets[state.target].url, 1));
  return nextPlugin(state);
}

function nextPlugin(state, why) {
  if (why) report(state, why);
  state.at += 1;
  state.targets = [];
  state.target = 0;
  state.passes = 0;
  // Cleared here as well as set on the next plugin's page: carrying a `true` into
  // a plugin whose page was never read would reject a healthy queue.
  state.broken = false;
  state.brokenSlug = '';
  state.stuck = [];
  write(state);

  // Every plugin is walked once: a slug that has already been visited is one the
  // listing moved, not one with new work.
  while (state.at < state.plugins.length && state.visited.includes(state.plugins[state.at])) {
    state.at += 1;
  }
  write(state);

  if (state.at >= state.plugins.length) return stop(state, 'liste bitti');
  return hop(state, pluginUrl(state.plugins[state.at]));
}

function stop(state, why) {
  state.running = false;
  state.note = why;
  write(state);
  report(state, `durdu: ${why}`);
}

async function hop(state, url) {
  write(state);
  say(`${state.note ? `${state.note} · ` : ''}geçiliyor: ${url.replace(location.origin, '')}`);
  await pause(HOP_PAUSE_MS);
  if (halted) return;
  location.href = url;
}

const listingUrl = (page) => `${LISTING}?s&page=${page}&filter=${LISTING_FILTER}`;
const pluginUrl = (slug) => `${LISTING}${slug}/`;

function pageOf(url, page) {
  const at = new URL(url, location.origin);
  at.searchParams.set('page', String(page));
  return at.toString();
}

/** Fetch a page of the site itself, pacing a 429 rather than failing on it. */
async function load(url) {
  let wait = 5_000;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const reply = await fetch(url, { credentials: 'include' });
    if (reply.ok) {
      const type = reply.headers.get('content-type') ?? '';
      if (!type.includes('html')) throw new Error(`beklenmeyen içerik türü: ${type}`);
      return new DOMParser().parseFromString(await reply.text(), 'text/html');
    }
    if (reply.status !== 429) throw new Error(`${reply.status} ${reply.statusText}`);
    await pause(wait);
    wait *= 2;
  }
  throw new Error('429 — istekler sınırlandı');
}

/** Poll until the probe returns something other than null, or the time runs out. */
async function until(probe, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const answer = probe();
    if (answer !== null && answer !== undefined) return answer;
    if (Date.now() > deadline || halted) return null;
    await pause(250);
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ───────────────────────────── what the owner sees ─────────────────────────────

/**
 * Write the decision beside the row and colour the row itself.
 *
 * Both of the string's rows are coloured, because which of them the reader is
 * looking at is their own doing: the preview is the queue, and the editor is what
 * opening a row leaves behind. GlotPress colours a row's cells by status, so the
 * colour has to be put on the cells and has to outrank that.
 */
function annotate(row, kind, what) {
  const pair = rowsFor(row.originalId);
  for (const one of pair) {
    one.classList.add('wpt-hit');
    one.dataset.wptKind = kind;
  }
  // A write re-renders both rows, so the note goes on whichever preview the page
  // holds now rather than on the one the walk read.
  const preview = pair.find((one) => one.classList.contains('preview')) ?? row.element;

  const note = document.createElement('div');
  note.className = 'wpt-note';
  note.dataset.kind = kind;
  note.textContent = what;
  const cell = preview.querySelector('td.translation');
  const wording = cell?.querySelector('.translation-text');
  if (wording) wording.after(note);
  else cell?.append(note);
}

function mount() {
  const panel = document.createElement('div');
  panel.id = 'wpt-tm-panel';
  panel.innerHTML = `
    <style>
      #wpt-tm-panel { position: fixed; inset-block-end: 12px; inset-inline-end: 12px; z-index: 2147483647;
        max-width: 440px; padding: 10px 12px; border-radius: 8px; font: 13px/1.5 system-ui, sans-serif;
        background: #111827; color: #f9fafb; box-shadow: 0 8px 24px rgb(0 0 0 / .4); }
      #wpt-tm-panel button { font: inherit; margin-inline-end: 6px; margin-block-start: 4px; padding: 3px 10px;
        cursor: pointer; border: 1px solid #6c727d; border-radius: 4px; background: transparent; color: inherit; }
      #wpt-tm-panel .wpt-status { display: block; margin-block-start: 6px; color: #b9bec7; word-break: break-word; }
      .wpt-note { margin-block-start: 4px; padding: 2px 6px; border-radius: 4px; font-size: 12px;
        background: #1c2332; color: #e6e8ec; }
      .wpt-note[data-kind="onay"] { background: #0d2c2d; }
      .wpt-note[data-kind="eslesme"] { background: #122d40; }
      .wpt-note[data-kind="kaydet"] { background: #33280f; }
      .wpt-note[data-kind="red"] { background: #2d1420; }
      .wpt-note[data-kind="sorun"] { background: #361c25; }
      #translations tr.wpt-hit > td { background-color: #e8f1fb !important; }
      #translations tr.wpt-hit > td:first-child { box-shadow: inset 3px 0 0 #2a6fb8; }
      #translations tr.wpt-hit[data-wpt-kind="onay"] > td { background-color: #e3f5e8 !important; }
      #translations tr.wpt-hit[data-wpt-kind="onay"] > td:first-child { box-shadow: inset 3px 0 0 #2f7d4f; }
      #translations tr.wpt-hit[data-wpt-kind="kaydet"] > td { background-color: #fdf4e3 !important; }
      #translations tr.wpt-hit[data-wpt-kind="kaydet"] > td:first-child { box-shadow: inset 3px 0 0 #b5791f; }
      #translations tr.wpt-hit[data-wpt-kind="red"] > td { background-color: #f6e6f0 !important; }
      #translations tr.wpt-hit[data-wpt-kind="red"] > td:first-child { box-shadow: inset 3px 0 0 #7d2a59; }
      #translations tr.wpt-hit[data-wpt-kind="sorun"] > td { background-color: #fdeaee !important; }
      #translations tr.wpt-hit[data-wpt-kind="sorun"] > td:first-child { box-shadow: inset 3px 0 0 #b3344f; }
    </style>
    <b>wp-translator · bellek onayı</b>
    <div>
      <button data-act="dry" title="İlk iki liste sayfasının eklentilerini gezer, her satıra ne yapılacağını yazar, hiçbir şeye dokunmaz">Kuru gezinti</button>
      <button data-act="live" title="Gezer; aynı olanı onaylar, farklı olana bellektekini yazar, yerelleştirilemeyen eklentinin satırlarını reddeder">Gez ve uygula</button>
      <button data-act="stop" title="Yürüyen gezintiyi durdurur">Durdur</button>
      <button data-act="forget" title="Çeviri belleği önbelleğini siler">Önbelleği temizle</button>
    </div>
    <span class="wpt-status">hazır</span>
  `;
  document.body.append(panel);

  const state = read();
  panel.querySelector('[data-act="dry"]').addEventListener('click', () => begin('dry'));
  panel.querySelector('[data-act="live"]').addEventListener('click', () => {
    if (
      confirm(
        'Sayfalarca eklentide üç şey yapılacak:\n\n' +
          '· bellekteki karşılıkla birebir aynı olan satırlar onaylanacak,\n' +
          '· bellek %100 başka bir karşılık veriyorsa o karşılık satıra yazılacak,\n' +
          '· "properly prepared for localization" bildirimi taşıyan eklentilerin tüm bekleyen ve fuzzy satırları reddedilecek.\n\n' +
          'Devam edilsin mi?',
      )
    ) {
      begin('live');
    }
  });
  panel.querySelector('[data-act="stop"]').addEventListener('click', () => {
    halted = true;
    const running = read();
    if (running) stop(running, 'elle durduruldu');
    else say('yürüyen gezinti yok');
  });
  panel.querySelector('[data-act="forget"]').addEventListener('click', () => {
    try {
      localStorage.removeItem(CACHE_KEY);
    } catch {
      // Nothing kept is nothing to forget.
    }
    say('önbellek temizlendi');
  });

  if (state?.running) report(state, `${state.mode === 'live' ? 'onaylıyor' : 'kuru'} · sürüyor`);
  else say(`hazır · kuru gezinti ${DRY_LIST_PAGES} liste sayfası · önbellekte ${Object.keys(cacheAll()).length} dizge`);
}

function begin(mode) {
  halted = false;
  const state = blank(mode);
  write(state);
  say('başlıyor…');
  void resume(state);
}

/** The run's one line, also echoed to the console so a finished page still says what happened. */
function say(what) {
  const line = document.querySelector('#wpt-tm-panel .wpt-status');
  if (line) line.textContent = what;
  console.info('[wpt-tm]', what);
}

function report(state, what) {
  const c = state.counts;
  say(
    `${what} · ${state.at + 1}/${state.plugins.length} eklenti · ${c.rows} satır · ` +
      `${c.approved} onaylandı · ${c.saved} kaydedildi · ${c.rejected} reddedildi · ` +
      `${c.asked} soruldu · ${c.cached} önbellekten` +
      (c.plural ? ` · ${c.plural} çoğul atlandı` : '') +
      (c.unconfirmed ? ` · ${c.unconfirmed} onaylanamadı` : '') +
      (c.failed ? ` · ${c.failed} yanıt gelmedi` : ''),
  );
}

function boot() {
  const listening = listen();
  console.info(
    `[wpt-tm] sayfanın istekleri ${listening ? 'dinleniyor' : 'dinlenemiyor — ret sebepleri okunamaz'}`,
  );
  mount();
  const state = read();
  if (state?.running) void resume(state);
}

// A bare DOM loads this file for its decisions alone; the page is what starts a run.
if (typeof document !== 'undefined') boot();
if (typeof module !== 'undefined') {
  module.exports = {
    place,
    slugOf,
    setKind,
    chooseSets,
    noCodeProject,
    carries,
    complaint,
    countOf,
    parseScore,
    hundredPercent,
    isExactMatch,
  };
}
