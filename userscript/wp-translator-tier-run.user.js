// ==UserScript==
// @name         wp-translator · tamamlanma oranına göre kuyruk eleme
// @namespace    https://github.com/turker/wp-translator
// @version      1.0.0
// @description  Bekleyen girdisi olan eklentileri sırayla gezer; her alt projenin bekleyen kuyruğu onaylandığında ulaşacağı oranı hesaplar, %75'e çıkanları elle bakmak üzere listeler, %25–75 arasını çeviri belleği ve yerel sunucunun modeliyle kapatır, %25'in altında kalanları reddeder.
// @match        https://translate.wordpress.org/locale/tr/default/wp-plugins/*
// @match        https://translate.wordpress.org/projects/wp-plugins/*/tr/default/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

'use strict';

/**
 * A walk over the pending queues that spends work only where it can change what
 * WordPress ships.
 *
 * A locale is shown in a plugin once its translation reaches 90%. Three good
 * suggestions on a project at 5% therefore change nothing at all, and checking
 * them by hand costs the same as checking the ones that matter. So each
 * sub-project is first asked one question: **if every waiting and fuzzy row in it
 * were settled, what would it reach?** The answer decides what happens to its
 * rows, and the rows are only ever read after that.
 *
 * - `>= 75` — within reach of shipping, so the owner looks at it. Listed, untouched.
 * - `25 .. 74` — worth closing: GlotPress's own memory where it answers, the
 *   local tool's model where it does not.
 * - `< 25` — out of reach whatever is done, so the queue is rejected.
 *
 * Nothing is written through an API: every write is GlotPress's own button being
 * pressed, so the run has exactly the rights the logged-in session has. The model
 * is reached through the owner's local server, which is the only thing here that
 * is not translate.wordpress.org.
 */

/** Where the walk starts, and the ordering that makes it worth walking. */
const LISTING = 'https://translate.wordpress.org/locale/tr/default/wp-plugins/';
const LISTING_FILTER = 'strings-waiting-and-fuzzy-asc';

/** The owner's local tool. Reached from the page's own context, so it answers CORS. */
const SERVER = 'http://127.0.0.1:4173';

/**
 * The bands, as projected percentages.
 *
 * A sub-project at exactly 75 is the owner's to look at, and one at exactly 25 is
 * worth closing — the edges belong to the kinder side, because a rejection is the
 * one decision here that is hard to undo.
 */
const MANUAL_AT = 75;
const AUTO_AT = 25;

/**
 * The run, and what it is for the owner to look at, kept where closing the tab
 * does not end them.
 *
 * The listing runs to dozens of pages and its last ones carry thousands of rows
 * each, so a run is days of work and has to survive a browser restart.
 * `sessionStorage`, which the memory-approval walk uses, would start the list over
 * every morning.
 */
const STATE_KEY = 'wpt-tier-run';
const MANUAL_KEY = 'wpt-tier-manual';

/**
 * What the translation memory answered for a source string, kept across pages.
 *
 * The memory is a property of the locale, not of the project, so the same string
 * in the next plugin is the same answer — and a plugin queue is mostly strings
 * every other plugin also has. Keyed on the source text alone: `msgctxt` is not
 * what the memory is asked about.
 *
 * **Shared with the memory-approval walk**, which is why the key is its name and
 * not this script's. Both read the same container with the same selectors and keep
 * the same 100% filter, so an answer either one stored is an answer the other
 * would have got — and between them they walk the same listing, where most of the
 * cost is asking about strings every plugin has. The cost of sharing is that
 * **Önbelleği temizle** empties it for both.
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
 * Settling a row pulls rows from the next page onto this one, so a page that
 * settled something is worked again. A row that reports success without leaving
 * the queue would otherwise be worked for ever.
 */
const PASS_LIMIT = 20;

/** How many rows go to the model at once, and how often its ticket is asked about. */
const BATCH = 10;
const POLL_MS = 1_500;

/**
 * How many listing pages a dry run takes, and therefore how far it walks.
 *
 * A dry run is there to show that the bands land where they should and that the
 * memory and the model answer, which the first plugins say. It still asks both,
 * so walking the whole listing to decide nothing would spend the model on every
 * row in it. A live run takes the listing whole.
 */
const DRY_LIST_PAGES = 2;

/**
 * How long one call to the local server is given, and how many times a dropped
 * one is sent again.
 *
 * A judging batch is minutes of model time, but no request carries it: the route
 * hands back a ticket and the answer is collected by polling, so every request
 * here is milliseconds of work.
 */
const REQUEST_TIMEOUT_MS = 30_000;
const TRANSPORT_ATTEMPTS = 2;

/**
 * The CLIs the server can be asked to use, and with what.
 *
 * They are named here rather than discovered because the working combination is a
 * property of the owner's plans, not of the page — and a model that is out of
 * quota does not fail, it hangs.
 */
const ENGINES = {
  opencode: { engine: 'opencode', agent: 'wp-translator', model: 'zai-coding-plan/glm-5.3-flash' },
  agy: { engine: 'agy', model: 'gemini-3.8-flash-low' },
};

const ENGINE_LABELS = { opencode: 'opencode · GLM 5.3 Flash', agy: 'agy · Gemini 3.8 Flash' };
const ENGINE_REMEMBERED = 'wpt-engine';

/** The sub-projects, and the two pairs each plugin's work is chosen out of. */
const SET_KINDS = ['dev', 'dev-readme', 'stable', 'stable-readme'];
const PAIRS = [
  ['dev', 'stable'],
  ['dev-readme', 'stable-readme'],
];

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

/** The project path as GlotPress spells it, e.g. `wp-plugins/connections/stable`. */
function projectPath(pathname) {
  const match = /\/projects\/(.+?)\/[a-z]{2,3}(?:-[a-z]+)?\/default\//.exec(pathname);
  return match ? match[1] : '';
}

/**
 * The sub-projects to work, one out of each pair, by where the pending rows are.
 *
 * Taking development because it exists is what skips the work: a plugin's queue
 * sits in whichever set its submissions were made against, and a dev that is in
 * step beside a stable that is not means walking past every pending row there is.
 * Where both hold some they hold the *same* submissions, so the larger queue is
 * the fuller copy rather than more work — and a tie is the same rows either way,
 * which trunk takes, being where a plugin's current strings live.
 */
function chooseSets(pending) {
  const chosen = [];
  for (const [trunk, released] of PAIRS) {
    const onTrunk = pending[trunk] ?? 0;
    const onReleased = pending[released] ?? 0;
    if (onTrunk === 0 && onReleased === 0) continue;
    chosen.push(onReleased > onTrunk ? released : trunk);
  }
  return chosen;
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
 * Where a sub-project stands, and where settling its queue would take it.
 *
 * `all` counts **originals** while the status counts count **translations**, so an
 * original carrying both a current translation and a pending suggestion is in two
 * of them — and settling that row replaces a translation that was already current.
 * The gain is therefore not the size of the queue but the originals that have some
 * translation and are not yet current: everything except those with none at all
 * and those sent back for changes.
 *
 * `ceil` is not the site's own rounding, which comes from cached counters and
 * cannot be reproduced. It is chosen for overstating a borderline set, which gets
 * that set worked instead of rejected.
 */
function projectionOf(counts) {
  const all = counts.all ?? 0;
  if (all <= 0) return { current: 0, projected: 0, gain: 0 };

  const settled = all - (counts.untranslated ?? 0) - (counts.changesRequested ?? 0);
  return {
    current: Math.ceil(((counts.translated ?? 0) / all) * 100),
    projected: Math.ceil((settled / all) * 100),
    gain: settled - (counts.translated ?? 0),
  };
}

/** Which band a sub-project falls in, and therefore what happens to its rows. */
function tierOf(projected) {
  if (projected >= MANUAL_AT) return 'manual';
  if (projected >= AUTO_AT) return 'auto';
  return 'reject';
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

/**
 * What a judgement means for the row it is about.
 *
 * `exact` is the glossary holding this very wording, which a human approved
 * upstream, and `agreed` is the model saying the wording is acceptable — both are
 * approvals. A `flagged` row is only written to when there is a wording the
 * checks already accepted; without one there is nothing to offer, so the row is
 * left for a person. A lone `unknown` is the model skipping one id, which is not
 * agreement and not a defect either.
 */
function actOn(judgement) {
  if (judgement.verdict === 'exact' || judgement.verdict === 'agreed') return 'approve';
  if (judgement.verdict === 'flagged') return judgement.proposal ? 'save' : 'leave';
  return 'leave';
}

/**
 * Why there is no point asking again, or null.
 *
 * `unknown` says nothing about which of two things happened: the model answered
 * the batch and skipped this one id, or there was no answer at all because the
 * CLI is out of quota. The first is one row to leave alone; the second costs the
 * server its whole timeout per batch, page after page, so the run stops on it.
 *
 * The server says which, in `unreachable`. "Every verdict is unknown" is kept as a
 * second trigger but is not the test: the checks and the glossary settle rows in
 * the same batch, so a provider that is gone hides behind them.
 */
function silenced(answer) {
  if (answer.unreachable) return answer.unreachable;
  const judgements = answer.judgements ?? [];
  if (judgements.length > 0 && judgements.every((one) => one.verdict === 'unknown')) {
    return judgements[0].reason ?? 'model yanıt vermedi';
  }
  return null;
}

// ───────────────────────────── the run's state ─────────────────────────────

function blank(mode) {
  return {
    running: true,
    mode,
    phase: 'collect',
    listPage: 1,
    lastListPage: 0,
    plugins: [],
    at: 0,
    visited: [],
    targets: [],
    target: 0,
    passes: 0,
    stuck: [],
    note: '',
    counts: {
      plugins: 0,
      sets: 0,
      manual: 0,
      rows: 0,
      matched: 0,
      saved: 0,
      approved: 0,
      rejected: 0,
      asked: 0,
      cached: 0,
      left: 0,
      plural: 0,
      unconfirmed: 0,
      failed: 0,
    },
  };
}

function read() {
  try {
    const kept = localStorage.getItem(STATE_KEY);
    return kept ? JSON.parse(kept) : null;
  } catch {
    // A private window or blocked site data: there is simply no run to resume.
    return null;
  }
}

function write(state) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // Not fatal while the page lasts; the next load starts over.
  }
}

function clear() {
  try {
    localStorage.removeItem(STATE_KEY);
  } catch {
    // Nothing to do: there is no run either way.
  }
}

// ───────────────── what the owner is to look at, and what was asked ─────────────────

/**
 * The sub-projects the run decided were the owner's to judge.
 *
 * Kept outside the run's own state so that resetting a run does not throw the
 * list away: it is the run's only product that nobody else records.
 */
function manualAll() {
  try {
    return JSON.parse(localStorage.getItem(MANUAL_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function manualAdd(entry) {
  const all = manualAll();
  if (all.some((one) => one.path === entry.path)) return all.length;
  all.push(entry);
  try {
    localStorage.setItem(MANUAL_KEY, JSON.stringify(all));
  } catch {
    // Full or blocked: the panel still shows what this page's run found.
  }
  return all.length;
}

/** The list as a table the owner can paste somewhere. */
function manualText() {
  const all = manualAll();
  if (all.length === 0) return '';
  return all
    .map(
      (one) =>
        `${one.path}\t%${one.current} → %${one.projected}\t${one.pending} satır\t${one.all} dizge`,
    )
    .join('\n');
}

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
  if (keys.length > CACHE_LIMIT) {
    for (const key of keys.slice(0, keys.length - CACHE_LIMIT)) delete all[key];
  }
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch {
    // Full or blocked: the run goes on asking GlotPress instead.
  }
}

// ───────────────────────── talking to the local server ─────────────────────────

/** The chosen CLI, as the server's routes take it. */
function engineChoice() {
  return ENGINES[chosenEngine()] ?? ENGINES.opencode;
}

function chosenEngine() {
  try {
    const kept = localStorage.getItem(ENGINE_REMEMBERED);
    if (kept && ENGINES[kept]) return kept;
  } catch {
    // Private windows and blocked site data both throw; the default stands.
  }
  return 'opencode';
}

function rememberEngine(name) {
  try {
    localStorage.setItem(ENGINE_REMEMBERED, name);
  } catch {
    // The choice holds for this page either way.
  }
}

/**
 * One call to the local server, sent again when the transport dropped it.
 *
 * The script is granted nothing, so this is the page's own `fetch` reaching
 * 127.0.0.1 — which the browser allows only because the server answers that
 * origin. Retrying is cheap: the server finishes a batch and writes `ai_memory`
 * whether or not anybody is still listening, so the second ask is served from it.
 */
async function ask(path, body, method = 'POST') {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await request(path, body, method);
    } catch (problem) {
      if (attempt > TRANSPORT_ATTEMPTS || !problem.transport) throw problem;
      await pause(attempt * 1_000);
    }
  }
}

/**
 * Start work and collect it by ticket.
 *
 * Nothing is held open: a judging batch takes minutes, and a request that long
 * is a request with nothing watching the far end of it. Polling keeps each call
 * to milliseconds and the work survives whatever happens to this page.
 */
async function await_(path, body) {
  const { job } = await ask(path, body);
  if (!job) throw new Error('Sunucu fiş döndürmedi; eski bir sürüm çalışıyor olabilir.');

  for (;;) {
    await pause(POLL_MS);
    if (halted) throw new Error('elle durduruldu');
    const state = await ask(`/api/jobs/${job}`, undefined, 'GET');
    if (!state.done) continue;
    if (state.error) throw new Error(state.error);
    return state.result;
  }
}

async function request(path, body, method) {
  let reply;
  try {
    reply = await fetch(`${SERVER}${path}`, {
      method,
      mode: 'cors',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch (problem) {
    // Three causes read alike from here: the server is not listening, the browser
    // refused the call to a private address, or it was simply dropped. Only the
    // last is worth sending again, and a name is all there is to tell them apart.
    const reason = problem instanceof Error ? problem.name : String(problem);
    const failure = new Error(
      `${SERVER} adresine ulaşılamadı (${reason}). Sunucu çalışıyor mu, ` +
        've tarayıcı bu sayfadan yerel adrese isteğe izin veriyor mu?',
    );
    failure.transport = reason === 'TimeoutError' || reason === 'AbortError';
    throw failure;
  }

  if (!reply.ok) {
    // The body carries the server's own reason; without it a failure reads only
    // as "500" and says nothing about what to fix.
    const detail = (await reply.text().catch(() => '')).trim().slice(0, 300);
    throw new Error(`${reply.status} ${reply.statusText}${detail ? ` — ${detail}` : ''}`);
  }
  return reply.json();
}

// ───────────────────────────── reading a page ─────────────────────────────

/**
 * GlotPress's own editor settings, as `wp_localize_script` leaves them.
 *
 * Read out of the inline script rather than off `window`, because a fetched page
 * has no globals at all.
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
    const pending = countOf(
      project.querySelector('.project-status-waiting .project-status-value')?.textContent,
    );
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
 *
 * The band is **not** decided here. The plugin page gives the status counts but
 * not GlotPress's count of originals, and adding the status counts up does not
 * produce it — the set's own page does, in its filter bar, and that page is
 * loaded anyway to work the rows.
 */
function targetsFrom(root) {
  const found = new Map();
  for (const row of root.querySelectorAll('table.locale-sub-projects tbody tr')) {
    const link = row.querySelector('td.set-name a[href]');
    if (!link) continue;
    const kind = setKind(new URL(link.getAttribute('href'), location.origin).pathname);
    if (!kind) continue;
    found.set(kind, { waiting: queue(row, 'waiting'), fuzzy: queue(row, 'fuzzy') });
  }

  const pending = {};
  for (const [kind, queues] of found) {
    pending[kind] = (queues.waiting?.count ?? 0) + (queues.fuzzy?.count ?? 0);
  }

  const targets = [];
  for (const kind of chooseSets(pending)) {
    for (const status of ['waiting', 'fuzzy']) {
      const one = found.get(kind)[status];
      if (one) targets.push({ url: one.url, kind, status, count: one.count });
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
 * The set's own counts, from the filter bar of whatever page is open.
 *
 * Read by the filter each link carries rather than by its label, because the
 * labels are English prose and the filters are GlotPress's own spelling. The bar
 * is rendered from the set and not from the page, so a page opened under
 * `?filters[status]=waiting` still carries every one of them.
 */
function readCounts(root) {
  const counts = { all: 0, translated: 0, untranslated: 0, waiting: 0, changesRequested: 0, fuzzy: 0 };
  const byStatus = {
    current: 'translated',
    untranslated: 'untranslated',
    waiting: 'waiting',
    changesrequested: 'changesRequested',
    fuzzy: 'fuzzy',
  };

  for (const link of root.querySelectorAll('.filter-toolbar a[href]')) {
    // The bar also holds its own "Filter" and "Sort" toggles, which are links to
    // nothing and carry no number. A parenthesised count is what makes a link one
    // of the set's own tallies.
    if (!/\(\s*[\d.,\s]+\)/.test(link.textContent ?? '')) continue;

    const at = new URL(link.getAttribute('href'), location.origin);
    const filtered = [...at.searchParams.keys()].some((key) => key.startsWith('filters['));
    if (!filtered) {
      // The one tally with no filter on it is the set itself.
      counts.all = countOf(link.textContent);
      continue;
    }
    const field = byStatus[at.searchParams.get('filters[status]') ?? ''];
    if (field) counts[field] = countOf(link.textContent);
  }
  return counts;
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
      context: contextOf(editor),
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
 * The string's `msgctxt`, which is what separates two readings of one English
 * word.
 *
 * Taken from the editor's own context block rather than from the preview's tag
 * list, where the same class sits beside a priority bubble carrying prose. Empty
 * for a string that has none, which is most of them.
 */
function contextOf(editor) {
  const span = editor.querySelector('.source-details__context .context');
  return (span?.textContent ?? '').trim();
}

/** Re-find a row's elements, which a write to the page replaces. */
function relocate(row) {
  for (const one of document.querySelectorAll('#translations tr.preview[row]')) {
    const id = one.getAttribute('row') ?? '';
    if (id.split('-')[0] !== String(row.originalId)) continue;
    row.id = id;
    row.translationId = Number(id.split('-')[1]) || null;
    row.element = one;
    row.editor = document.getElementById(`editor-${id}`) ?? row.editor;
    row.pending = /\bstatus-(waiting|fuzzy)\b/.test(one.className);
    return row;
  }
  row.pending = false;
  return row;
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
      const text =
        this.responseType === '' || this.responseType === 'text'
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
    if (data?.success === false) {
      return typeof data.data === 'string' ? data.data.slice(0, 200) : 'istek reddedildi';
    }
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
 * Collect every plugin slug before settling anything.
 *
 * The listing is sorted ascending by what is waiting, so every row settled moves
 * a plugin in it and shifts the ones behind. Walking the listing live and
 * following its paging would skip whatever crossed a page boundary while the walk
 * was working; the list is therefore taken first and the walk follows its own copy.
 */
async function collect(state) {
  for (;;) {
    if (halted) return;
    say(
      `eklenti listesi toplanıyor · sayfa ${state.listPage}${state.lastListPage ? `/${state.lastListPage}` : ''} · ${state.plugins.length} eklenti`,
    );

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

/** On a plugin's page: pick its queues and go to the first. */
function openPlugin(state) {
  const slug = slugOf(location.pathname) || state.plugins[state.at];
  if (!state.visited.includes(slug)) state.visited.push(slug);
  state.counts.plugins += 1;
  state.targets = targetsFrom(document);
  state.target = 0;
  state.passes = 0;
  write(state);

  if (state.targets.length === 0) return nextPlugin(state, `${slug}: bekleyen alt proje yok`);
  const label = state.targets.map((one) => `${one.kind}·${one.status}·${one.count}`).join(' ');
  say(`${slug} · ${label}`);
  return hop(state, pageOf(state.targets[0].url, 1));
}

/**
 * Work one filter page: decide the band from the set's own counts, then read every
 * row before writing to any of them.
 *
 * Reads and writes are separated because a write re-renders the row it touched and
 * the model is asked in batches: deciding the whole page first means one question
 * per ten rows and no row read through a page that has moved under it.
 */
async function workSet(state) {
  // GlotPress binds the row's own click handler on its own schedule, and opening
  // a row before that does nothing at all — which reads as a memory that never
  // answers.
  await pause(SETTLE_MS);
  if (state.mode === 'live' && !mayApprove(document)) {
    return stop(state, 'bu oturum onaylayamıyor — GTE olarak giriş yapılı mı?');
  }

  const counts = readCounts(document);
  const projection = projectionOf(counts);
  const tier = tierOf(projection.projected);
  const path = projectPath(location.pathname);

  // Without the set's own count of originals there is no band to decide, and
  // guessing one from the status counts is what overstates a set by three rows.
  if (counts.all === 0) {
    console.warn('[wpt-tier] filtre çubuğu okunamadı:', path);
    report(state, `${path}: dizge sayısı okunamadı, atlanıyor`);
    return nextTarget(state);
  }

  const band = `%${projection.current} → %${projection.projected}`;
  if (tier === 'manual') {
    const total = manualAdd({
      path,
      current: projection.current,
      projected: projection.projected,
      pending: counts.waiting + counts.fuzzy,
      all: counts.all,
    });
    state.counts.manual += 1;
    report(state, `${path} · ${band} · elle bakılacaklara eklendi (${total})`);
    return nextTarget(state);
  }

  const rows = readRows(document);
  const label = `${setKind(location.pathname) ?? ''} · ${tier} · ${band}`;

  const settledHere =
    tier === 'reject'
      ? await rejectRows(state, rows, label)
      : await closeRows(state, rows, label, path);

  if (!state.running) return;
  report(state, `${label} · ${rows.length} satır bitti`);

  // Settling a row takes it out of the queue and pulls the next page's rows onto
  // this one, so this page is worked again before the walk moves forward.
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
 * A set out of reach: every pending row goes back.
 *
 * Nothing is consulted, because nothing it could say would matter — the wording,
 * the memory and the plural forms are all beside the point when approving the
 * whole queue still leaves the plugin short of shipping.
 */
async function rejectRows(state, rows, label) {
  let settled = 0;
  for (const [index, row] of rows.entries()) {
    if (halted) return settled;
    say(`${label} · ${index + 1}/${rows.length}`);
    state.counts.rows += 1;
    if (state.stuck.includes(row.originalId)) continue;

    if (state.mode !== 'live') {
      annotate(row, 'red', `${label} — reddedilecekti`);
      continue;
    }
    const gone = await press(row, REJECT_SELECTORS, 'status-rejected', statusWrite);
    await pause(ROW_PAUSE_MS);
    if (gone.ok) {
      state.counts.rejected += 1;
      annotate(row, 'red', 'ulaşılamayan oran — reddedildi');
      settled += 1;
    } else {
      state.counts.unconfirmed += 1;
      state.stuck.push(row.originalId);
      annotate(row, 'sorun', `reddedilemedi: ${gone.why}`);
    }
    write(state);
  }
  return settled;
}

/**
 * A set worth closing: the memory first, the model for what it does not answer.
 *
 * In three passes. The memory is asked row by row, because its answer arrives in
 * the row's own sidebar; the model is asked ten rows at a time, because that is
 * what one call costs either way; and only then is anything pressed, so no row is
 * read through a page a write has already re-rendered.
 */
async function closeRows(state, rows, label, path) {
  const plan = [];
  const toAsk = [];

  for (const [index, row] of rows.entries()) {
    if (halted) return 0;
    say(`${label} · bellek · ${index + 1}/${rows.length}`);
    state.counts.rows += 1;

    if (state.stuck.includes(row.originalId)) continue;
    if (row.forms !== 1) {
      // The memory answers a singular string, and a plural row judged on its
      // singular half settles a form nobody looked at.
      state.counts.plural += 1;
      continue;
    }
    if (!row.source) continue;
    if (!row.translation) {
      // A fuzzy row can carry an empty wording, and there is nothing to judge in
      // one: the checks refuse it before a model is ever asked. Translating it
      // instead is a different job from this one.
      state.counts.left += 1;
      annotate(row, 'sorun', 'çevirisi boş — bu koşu çeviri üretmiyor');
      continue;
    }

    const wordings = await remember(state, row);
    if (wordings === null) continue;

    if (wordings.length === 0) {
      toAsk.push(row);
      continue;
    }
    if (isExactMatch(wordings, row.translation)) {
      state.counts.matched += 1;
      plan.push({ row, act: 'approve', why: '%100 bellek eşleşmesi', kind: 'eslesme' });
    } else {
      // The first of GlotPress's own 100% suggestions is the one it puts at the top.
      plan.push({ row, act: 'save', wording: wordings[0], why: 'bellekteki karşılık', kind: 'kaydet' });
    }
    write(state);
  }

  for (let at = 0; at < toAsk.length; at += BATCH) {
    if (halted) return 0;
    const slice = toAsk.slice(at, at + BATCH);
    say(`${label} · model · ${at + slice.length}/${toAsk.length}`);
    const decided = await judge(state, slice, path);
    if (!state.running) return 0;
    plan.push(...decided);
  }

  let settled = 0;
  for (const [index, step] of plan.entries()) {
    if (halted) return settled;
    say(`${label} · uygula · ${index + 1}/${plan.length}`);
    if (await apply(state, step)) settled += 1;
    write(state);
  }
  return settled;
}

/**
 * Put a batch of rows to the model and turn its verdicts into steps.
 *
 * A provider that cannot be reached stops the run rather than costing a verdict
 * per row: the rows the memory already settled are kept, the state says where the
 * walk was, and the panel's own button picks it up from there.
 */
async function judge(state, slice, path) {
  let answer;
  try {
    answer = await await_('/api/judge', {
      ...engineChoice(),
      projectPath: path,
      items: slice.map((row) => ({
        // `-set-status/` takes the translation id, so judgements key on it.
        id: row.translationId,
        source: row.source,
        ...(row.context ? { context: row.context } : {}),
        translation: row.translation,
      })),
    });
  } catch (problem) {
    // The stop button interrupts the poll, and that is not a provider failing.
    stop(state, halted ? 'elle durduruldu' : `modele ulaşılamadı: ${problem.message}`);
    return [];
  }

  state.counts.asked += answer.asked ?? 0;
  const quiet = silenced(answer);
  if (quiet) {
    stop(state, `model yanıt vermiyor: ${quiet}`);
    return [];
  }
  const judgements = answer.judgements ?? [];

  const steps = [];
  for (const judgement of judgements) {
    const row = slice.find((candidate) => candidate.translationId === judgement.id);
    if (!row) continue;
    const act = actOn(judgement);
    if (act === 'leave') {
      state.counts.left += 1;
      annotate(row, 'sorun', judgement.reason ?? 'karar verilemedi');
      continue;
    }
    steps.push({
      row,
      act,
      ...(act === 'save' ? { wording: judgement.proposal } : {}),
      why: judgement.reason ?? 'model',
      kind: act === 'approve' ? 'onay' : 'kaydet',
    });
  }
  return steps;
}

/** Do one step, or say on the row why it could not be done. True when the row left the queue. */
async function apply(state, step) {
  const row = relocate(step.row);
  // Somebody else, or an earlier step, has already taken this row out of the queue.
  if (!row.pending) return false;

  if (state.mode !== 'live') {
    annotate(
      row,
      step.kind,
      step.act === 'approve'
        ? `${step.why} — onaylanacaktı`
        : `${step.why} — yazılacaktı: ${step.wording}`,
    );
    return false;
  }

  const done =
    step.act === 'approve'
      ? await press(row, APPROVE_SELECTORS, 'status-current', statusWrite)
      : await save(row, step.wording);
  await pause(ROW_PAUSE_MS);

  if (done.ok) {
    if (step.act === 'approve') state.counts.approved += 1;
    else state.counts.saved += 1;
    annotate(
      row,
      step.kind,
      step.act === 'approve' ? `${step.why} — onaylandı` : `${step.why} — yazıldı: ${step.wording}`,
    );
    return true;
  }

  state.counts.unconfirmed += 1;
  state.stuck.push(row.originalId);
  annotate(row, 'sorun', `${step.act === 'approve' ? 'onaylanamadı' : 'yazılamadı'}: ${done.why}`);
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
 * thousands of rows.
 */
let complained = false;
function complain(row) {
  if (complained) return;
  complained = true;
  console.warn(
    '[wpt-tier] çeviri belleği yanıtı bulunamadı; satırın HTML’i:',
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
      `[wpt-tier] düğme yok (${selectors.join(', ')}):`,
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
 * Write a wording into the row and press save.
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
    console.warn('[wpt-tier] çeviri alanı bulunamadı:', row.id);
    return { ok: false, why: 'çeviri alanı bulunamadı' };
  }

  area.value = wording;
  // GlotPress watches the field to enable its own save button and to size the box.
  area.dispatchEvent(new Event('input', { bubbles: true }));
  area.dispatchEvent(new Event('change', { bubbles: true }));

  const button = SAVE_SELECTORS.map((selector) => row.editor.querySelector(selector)).find(Boolean);
  if (!button) {
    console.warn(
      `[wpt-tier] kaydet düğmesi yok (${SAVE_SELECTORS.join(', ')}):`,
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
  if (state.target < state.targets.length) {
    return hop(state, pageOf(state.targets[state.target].url, 1));
  }
  return nextPlugin(state);
}

function nextPlugin(state, why) {
  if (why) report(state, why);
  state.at += 1;
  state.targets = [];
  state.target = 0;
  state.passes = 0;
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

/**
 * Stop, keeping where the walk was.
 *
 * The state is left on disk with `running` false rather than cleared: collecting
 * the listing is dozens of page loads and the walk is days long, so a provider that
 * went quiet at lunchtime must not cost the morning.
 */
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
  panel.id = 'wpt-tier-panel';
  panel.innerHTML = `
    <style>
      #wpt-tier-panel { position: fixed; inset-block-end: 12px; inset-inline-end: 12px; z-index: 2147483647;
        max-width: 460px; padding: 10px 12px; border-radius: 8px; font: 13px/1.5 system-ui, sans-serif;
        background: #111827; color: #f9fafb; box-shadow: 0 8px 24px rgb(0 0 0 / .4); }
      #wpt-tier-panel button, #wpt-tier-panel select { font: inherit; margin-inline-end: 6px; margin-block-start: 4px;
        padding: 3px 10px; cursor: pointer; border: 1px solid #6c727d; border-radius: 4px;
        background: transparent; color: inherit; }
      #wpt-tier-panel select option { background: #111827; }
      #wpt-tier-panel .wpt-status { display: block; margin-block-start: 6px; color: #b9bec7; word-break: break-word; }
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
    <b>wp-translator · oran eleme</b>
    <div>
      <select data-act="engine" title="Hangi CLI'ya sorulacak"></select>
    </div>
    <div>
      <button data-act="dry" title="İlk iki liste sayfasını gezer, her satıra ne yapılacağını yazar, hiçbir düğmeye basmaz — belleğe ve modele yine sorar">Deneme</button>
      <button data-act="live" title="Gezer ve uygular">Çalıştır</button>
      <button data-act="go-on" title="Duran koşuyu kaldığı yerden sürdürür">Devam</button>
      <button data-act="stop" title="Yürüyen koşuyu durdurur, kaldığı yeri saklar">Durdur</button>
    </div>
    <div>
      <button data-act="copy" title="Elle bakılacaklar listesini panoya kopyalar">Elle listesi</button>
      <button data-act="reset" title="Koşuyu sıfırlar; elle listesi ve önbellek kalır">Koşuyu sıfırla</button>
      <button data-act="forget" title="Çeviri belleği önbelleğini siler — bellek onayı betiğiyle paylaşımlı">Önbelleği temizle</button>
    </div>
    <span class="wpt-status">hazır</span>
  `;
  document.body.append(panel);

  const picker = panel.querySelector('[data-act="engine"]');
  for (const name of Object.keys(ENGINES)) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = ENGINE_LABELS[name] ?? name;
    picker.append(option);
  }
  picker.value = chosenEngine();
  picker.addEventListener('change', () => {
    rememberEngine(picker.value);
    say(`model: ${ENGINE_LABELS[picker.value] ?? picker.value}`);
  });

  panel.querySelector('[data-act="dry"]').addEventListener('click', () => begin('dry'));
  panel.querySelector('[data-act="live"]').addEventListener('click', () => {
    if (
      confirm(
        'Bekleyen girdisi olan her eklenti gezilecek ve her alt proje için şunlar yapılacak:\n\n' +
          `· kuyruğu onaylandığında %${MANUAL_AT} ve üstüne çıkanlar elle bakmak üzere listelenecek, satırlarına dokunulmayacak,\n` +
          `· %${AUTO_AT}–%${MANUAL_AT} arasına çıkanlarda çeviri belleğinin %100 karşılığı onaylanacak ya da yazılacak, ` +
          'bellek susuyorsa karar modele sorulacak,\n' +
          `· %${AUTO_AT} altında kalanların bütün bekleyen ve fuzzy satırları REDDEDİLECEK.\n\n` +
          'Liste onlarca sayfa; koşu günler sürer ve durduğu yerden devam eder. Başlatılsın mı?',
      )
    ) {
      begin('live');
    }
  });
  panel.querySelector('[data-act="go-on"]').addEventListener('click', () => {
    const kept = read();
    if (!kept) return say('sürdürülecek koşu yok');
    halted = false;
    kept.running = true;
    kept.note = '';
    write(kept);
    report(kept, 'sürdürülüyor');
    void resume(kept);
  });
  panel.querySelector('[data-act="stop"]').addEventListener('click', () => {
    halted = true;
    const running = read();
    if (running) stop(running, 'elle durduruldu');
    else say('yürüyen koşu yok');
  });
  panel.querySelector('[data-act="copy"]').addEventListener('click', () => {
    const text = manualText();
    if (!text) return say('elle bakılacak alt proje yok');
    void navigator.clipboard.writeText(text).then(
      () => say(`${manualAll().length} alt proje panoya kopyalandı`),
      () => {
        // A clipboard a page may not write to still has a console.
        console.info('[wpt-tier] elle bakılacaklar:\n' + text);
        say('panoya yazılamadı; liste konsolda');
      },
    );
  });
  panel.querySelector('[data-act="reset"]').addEventListener('click', () => {
    halted = true;
    clear();
    say('koşu sıfırlandı · elle listesi ve önbellek duruyor');
  });
  panel.querySelector('[data-act="forget"]').addEventListener('click', () => {
    try {
      localStorage.removeItem(CACHE_KEY);
    } catch {
      // Nothing kept is nothing to forget.
    }
    say('önbellek temizlendi · bellek onayı betiği de bu önbelleği kullanıyor');
  });

  const state = read();
  if (state?.running) report(state, `${state.mode === 'live' ? 'uyguluyor' : 'deneme'} · sürüyor`);
  else if (state) report(state, `duruyor: ${state.note || 'bilinmiyor'} · "Devam" ile sürer`);
  else {
    say(
      `hazır · ${ENGINE_LABELS[chosenEngine()]} · deneme ${DRY_LIST_PAGES} liste sayfası ` +
        `· elle listesinde ${manualAll().length} · önbellekte ${Object.keys(cacheAll()).length} dizge`,
    );
  }
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
  const line = document.querySelector('#wpt-tier-panel .wpt-status');
  if (line) line.textContent = what;
  console.info('[wpt-tier]', what);
}

function report(state, what) {
  const c = state.counts;
  say(
    `${what} · ${state.at + 1}/${state.plugins.length} eklenti · ${c.rows} satır · ` +
      `${c.approved} onaylandı · ${c.saved} yazıldı · ${c.rejected} reddedildi · ` +
      `${c.manual} elle · ${c.matched} bellek eşleşmesi · ${c.asked} modele soruldu · ` +
      `${c.cached} önbellekten` +
      (c.left ? ` · ${c.left} karar verilemedi` : '') +
      (c.plural ? ` · ${c.plural} çoğul atlandı` : '') +
      (c.unconfirmed ? ` · ${c.unconfirmed} yazılamadı` : '') +
      (c.failed ? ` · ${c.failed} bellek yanıtlamadı` : ''),
  );
}

function boot() {
  const listening = listen();
  console.info(
    `[wpt-tier] sayfanın istekleri ${listening ? 'dinleniyor' : 'dinlenemiyor — ret sebepleri okunamaz'}`,
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
    projectPath,
    chooseSets,
    countOf,
    parseScore,
    projectionOf,
    tierOf,
    hundredPercent,
    isExactMatch,
    actOn,
    silenced,
    carries,
    complaint,
    MANUAL_AT,
    AUTO_AT,
  };
}
