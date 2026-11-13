import { notify, withdraw } from './notify.ts';
export interface CheckFailure {
  rule: string;
  message: string;
}

export interface Candidate {
  translation: string;
  tag: string;
}

export interface Unit {
  id: number;
  msgid: string;
  msgidPlural: string | null;
  msgctxt: string | null;
  msgstr: string | null;
  msgstrPlural: string | null;
  state: 'untranslated' | 'review' | 'ok';
  provenance: 'glossary' | 'ai' | 'human' | null;
  /** What the service had when the project was imported. */
  upstream: 'current' | 'untranslated' | null;
  /** 1 when the quality checks refuse it. Stored, so the queue can filter. */
  blocked: number;
  failures: CheckFailure[];
  candidates: Candidate[];
  structured: boolean;
}

export interface Project {
  id: number;
  name: string | null;
  projectPath: string;
  subProject?: string | null;
  translateUrl: string;
  total: number;
  ok: number;
  review: number;
  untranslated: number;
}

export interface TermReading {
  translation: string;
  pos?: string;
  note?: string;
}

export interface TmSuggestion {
  source: string;
  translation: string;
  translationPlural?: string | null;
  similarity: number;
  tag?: string;
}

export interface GlossarySuggestion {
  id: number;
  source: string;
  translation: string;
  translationPlural?: string | null;
  pos?: string | null;
  note?: string | null;
  tag?: string | null;
  isOfficial?: boolean;
}

export interface UnitDetail {
  msgid?: string;
  refs: string | null;
  extractedComments: string | null;
  usageSurface: string | null;
  suggestions?: TmSuggestion[];
  terms?: { source: string; readings: TermReading[] }[];
  glossaryTerms?: GlossarySuggestion[];
}

/**
 * Every call to the server goes through here, which is why the reporting lives
 * here too. Components were throwing into an unhandled rejection: a write that
 * failed left the screen looking exactly like a write that worked.
 *
 * @param label names the write for the corner message; a read passes none.
 */
/** The group for "the server is not answering", withdrawn as soon as it does. */
const OFFLINE = 'offline';

const json = async <T>(input: string, init?: RequestInit, label?: string): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (problem) {
    // The server is a local process the owner starts by hand, so it goes away and
    // comes back. Tagged, because the message stops being true by itself.
    notify('error', `Sunucuya ulaşılamadı. Çalışıyor mu? (${describe(problem)})`, OFFLINE);
    throw problem;
  }

  withdraw(OFFLINE);

  if (!response.ok) {
    const errorReason = await reason(response);
    notify('error', `${label ?? 'İstek'} başarısız: ${errorReason}`);
    throw new Error(errorReason);
  }

  if (label) notify('ok', label);
  return response.json() as Promise<T>;
};

/** The server sends `{ error }`; fall back to the status when it cannot. */
const reason = async (response: Response): Promise<string> => {
  const body = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error;
  } catch {
    /* not JSON */
  }
  return `${response.status} ${response.statusText}`;
};

const describe = (problem: unknown): string =>
  problem instanceof Error ? problem.message : String(problem);

export const listProjects = () => json<Project[]>('/api/projects');

export interface Export {
  po: Blob;
  /** Entries in the file. */
  exported: number;
  /** Entries left out, because only approved translations are exported. */
  withheld: number;
}

/**
 * Fetch a project's PO and the counts the server reports with it.
 *
 * Not a plain navigation: the counts ride in headers, and a navigation throws them
 * away — which is how a file with nothing in it came to download silently.
 */
export async function exportPo(projectId: number): Promise<Export> {
  const response = await fetch(`/api/projects/${projectId}/export`);
  if (!response.ok) {
    notify('error', `PO indirilemedi: ${await reason(response)}`);
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return {
    po: await response.blob(),
    exported: Number(response.headers.get('x-exported') ?? 0),
    withheld: Number(response.headers.get('x-withheld') ?? 0),
  };
}

export type QueueView =
  | 'all'
  | 'untranslated'
  | 'waiting'
  | 'translated'
  | 'blocked'
  | 'upstream';

export interface UnitPage {
  rows: Unit[];
  /** Units matching the filter, not just this page. */
  total: number;
  counts: Record<QueueView, number>;
}

export const listUnits = (projectId: number, params: Record<string, string> = {}) =>
  json<UnitPage>(`/api/projects/${projectId}/units?${new URLSearchParams(params)}`);

/**
 * Apply an action to the ticked rows, or to everything a filter matches. The
 * filter travels as a query string rather than as the ids it stands for.
 */
export type BulkAction = 'approve' | 'clear' | 'glossary' | 'add_to_glossary';

export interface AddUnitsToGlossaryResult {
  added: number;
  skipped: number;
  empty: number;
  entries: { id: number; sourceText: string; pos: string; added: boolean }[];
}

export const addUnitsToGlossary = (
  projectId: number,
  target: { ids: number[] } | { params: Record<string, string> },
  pos = 'auto',
  override?: { translation?: string; translationPlural?: string },
) =>
  post<AddUnitsToGlossaryResult>(
    `/api/projects/${projectId}/add-to-glossary`,
    {
      ...('ids' in target
        ? { ids: target.ids }
        : { filter: new URLSearchParams(target.params).toString() }),
      pos,
      ...(override ?? {}),
    },
    'Sözlüğe ekle',
  );

export const bulkSetState = (
  projectId: number,
  action: BulkAction,
  target: { ids: number[] } | { params: Record<string, string> },
) =>
  post<{ changed: number; skipped: number }>(
    `/api/projects/${projectId}/bulk`,
    {
      action,
      ...('ids' in target
        ? { ids: target.ids }
        : { filter: new URLSearchParams(target.params).toString() }),
    },
    'Toplu işlem',
  );

export interface ReplaceResult {
  /** Translations in scope containing the text. */
  matched: number;
  /** Of those, how many were written. Zero on a preview. */
  changed: number;
  /** Of those written, how many the quality checks now refuse. */
  blocked: number;
}

/**
 * Replace text inside translations, across the same scope the bulk actions take.
 *
 * `preview` counts without writing, so the size of a change measured in thousands
 * of rows is known before it is made.
 */
export const replaceInTranslations = (
  projectId: number,
  find: string,
  replace: string,
  target: { ids: number[] } | { params: Record<string, string> },
  preview = false,
  caseSensitive = true,
) =>
  post<ReplaceResult>(
    `/api/projects/${projectId}/replace`,
    {
      find,
      replace,
      preview,
      caseSensitive,
      ...('ids' in target
        ? { ids: target.ids }
        : { filter: new URLSearchParams(target.params).toString() }),
    },
    preview ? undefined : 'Bul ve değiştir',
  );

export const unitDetail = (unitId: number) => json<UnitDetail>(`/api/units/${unitId}/detail`);

/**
 * Record a deliberate exception to one quality check on one string, with the
 * owner's reason.
 */
export const overrideCheck = (unitId: number, rule: string, reason: string) =>
  post<{ ok: true }>(`/api/units/${unitId}/override`, { rule, reason }, 'Kural atlandı');

/** @param approve settle the unit as well; saving alone leaves it waiting. */
export const saveUnit = (
  unitId: number,
  edit: { msgstr?: string; msgstrPlural?: string },
  approve = false,
) =>
  json<{ unit: Unit; blocked?: CheckFailure[] }>(
    `/api/units/${unitId}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...edit, approve }),
    },
    // Unlabelled: a refused save still answers 200, carrying `blocked`, so the
    // outcome is in the body and ReviewTable reports it.
  );

export interface Tag {
  id: number;
  name: string;
  entries: number;
}

export interface TrustedSource {
  id: number;
  translateUrl: string;
  projectPath: string;
  family: string;
  label: string | null;
  rank: number;
  lastSyncedAt: string | null;
  entries: number;
  tagIds: number[];
  translated: number;
  fuzzy: number;
  waiting: number;
  untranslated: number;
  totalStrings: number;
  percent: number;
  existingProjectId?: number | null;
}

export interface SyncProgress {
  running: boolean;
  done: number;
  total: number;
  current: string | null;
  errors: { source: string; message: string }[];
  glossaryTerms: number | null;
  /** True when only the picked sources ran, so the counts are partial. */
  partial: boolean;
  finishedAt: string | null;
  /** What each source's run did; a source that has not changed adds nothing. */
  results: { source: string; seen: number; added: number; linksRemoved: number; entriesRemoved: number }[];
}

export interface GlossaryEntry {
  id: number;
  sourceText: string;
  sourcePlural: string | null;
  msgctxt: string | null;
  pos: string | null;
  note: string | null;
  translation: string;
  translationPlural: string | null;
  origin: 'trusted' | 'owner';
  isOfficial?: number;
  tag: string;
  sources: number;
  /** Contexts this translation has been seen under; not part of its identity. */
  contexts: number;
  /** Translations this string has under this tag, including this one. */
  readings: number;
}

export interface EntrySource {
  label: string | null;
  projectPath: string;
  rank: number;
  translation: string;
}

const post = <T>(url: string, body: unknown, label?: string) =>
  json<T>(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    label,
  );

export const listTags = () => json<Tag[]>('/api/tags');

export const listSources = () => json<TrustedSource[]>('/api/sources');
export const addSource = (url: string, tagIds: number[], label?: string) =>
  post<{ id: number }>('/api/sources', { url, tagIds, label }, 'Kaynak eklendi');
export const reorderSources = (ids: number[]) => post<{ ok: true }>('/api/sources/reorder', { ids }, 'Sıra kaydedildi');
/** No `ids` means every source, plus the official term list. */
export const startSync = (ids?: number[]) =>
  post<SyncProgress>('/api/sources/sync', ids ? { ids } : {}, 'Güncelleme başlatıldı');
export const syncProgress = () => json<SyncProgress>('/api/sources/sync');
export const refreshSourcesStats = (ids?: number[], label?: string) =>
  post<{ updated: number }>('/api/sources/stats', ids ? { ids } : {}, label);

export const searchGlossary = (params: Record<string, string>) =>
  json<{ rows: GlossaryEntry[]; total: number }>(`/api/glossary?${new URLSearchParams(params)}`);
export interface EntryDetail {
  sources: EntrySource[];
  /** Where this translation has been seen. Informational only. */
  contexts: string[];
}

export const entryDetail = (id: number) => json<EntryDetail>(`/api/glossary/${id}`);

export interface NewEntry {
  sourceText: string;
  sourcePlural?: string;
  translation: string;
  translationPlural?: string;
  tagId?: number;
  pos?: string;
  note?: string;
}

export const createEntry = (entry: NewEntry) =>
  post<GlossaryEntry>('/api/glossary', entry, 'Sözlük girdisi eklendi');

/** Refused for anything upstream still carries; the server says why. */
export const deleteEntry = (id: number) =>
  json<{ removed: number }>(`/api/glossary/${id}`, { method: 'DELETE' }, 'Sözlük girdisi silindi');

/**
 * Whether this entry is the owner's own to remove. Mirrors `isOwnEntry` on the
 * server, so the button is disabled rather than refused after the click.
 */
export const isOwnEntry = (entry: GlossaryEntry): boolean => {
  if (entry.pos === null) {
    return entry.origin === 'owner' && entry.sources === 0;
  }
  return true;
};

export const bulkDeleteEntries = (ids: number[]) =>
  post<{ removed: number }>('/api/glossary/bulk-delete', { ids }, 'Seçilen terimler silindi');

export interface CopyMemoryResult {
  added: number;
  skipped: number;
  entries: { id: number; sourceText: string; pos: string; added: boolean }[];
}

export const copyMemoryToTerms = (ids: number[], pos?: string) =>
  post<CopyMemoryResult>(
    '/api/glossary/copy-from-memory',
    { ids, ...(pos && pos !== 'auto' ? { pos } : {}) },
    'Terimler sözlüğe aktarıldı',
  );

export const updateEntry = (
  id: number,
  translation: string,
  translationPlural?: string,
  note?: string,
  pos?: string,
  sourceText?: string,
) =>
  post<{ entry: GlossaryEntry; sourceWordingReturns: boolean }>(
    `/api/glossary/${id}`,
    {
      translation,
      ...(translationPlural !== undefined ? { translationPlural } : {}),
      ...(note !== undefined ? { note } : {}),
      ...(pos !== undefined ? { pos } : {}),
      ...(sourceText !== undefined ? { sourceText } : {}),
    },
    'Sözlük girdisi kaydedildi',
  );

export interface StyleRule {
  tagId: number | null;
  tagName: string | null;
  body: string;
  updatedAt: string | null;
}

export interface MergePreview {
  moving: number;
  colliding: number;
  projects: number;
  sources: number;
}

export interface AddProjectResult {
  projectId: number;
  strings: number;
  match: { filled: number; alternatives: number; unmatched: number };
  suggestedTags: string[];
}

export const createTag = (name: string) => post<{ id: number }>('/api/tags', { name }, 'Etiket oluşturuldu');
export const renameTag = (id: number, name: string) => post<{ ok: true }>(`/api/tags/${id}`, { name }, 'Etiket adı değiştirildi');
export const deleteTag = (id: number, force = false) =>
  json<{ ok: true }>(`/api/tags/${id}${force ? '?force=true' : ''}`, { method: 'DELETE' }, 'Etiket silindi');
export const previewMerge = (from: number, to: number) =>
  post<MergePreview>('/api/tags/merge', { from, to, preview: true });
export const mergeTags = (from: number, to: number, policy: 'keep-target' | 'take-source') =>
  post<MergePreview & { policy: string }>('/api/tags/merge', { from, to, policy }, 'Etiketler birleştirildi');

export const listStyleRules = () => json<StyleRule[]>('/api/style-rules');
export const saveStyleRule = (tagId: number | null, body: string) =>
  post<{ ok: true }>('/api/style-rules', { tagId, body }, 'Üslup rehberi kaydedildi');

export const addProject = (url: string, tagIds: number[]) =>
  post<AddProjectResult>('/api/projects', { url, tagIds }, 'Proje eklendi');
/** What a reload would throw away, for the confirmation. */
export const reloadCost = (id: number) => json<{ discards: number }>(`/api/projects/${id}/reload`);

export const reloadProject = (id: number) =>
  post<{ strings: number; discarded: number; match: AddProjectResult['match'] }>(
    `/api/projects/${id}/reload`,
    {},
    'Proje yenilendi',
  );

export const removeProject = (id: number) =>
  json<{ ok: true }>(`/api/projects/${id}`, { method: 'DELETE' }, 'Proje silindi');

export const bulkApprove = (ids: number[]) =>
  // Unlabelled for the same reason as saveUnit: `refused` rides on a 200.
  post<{ approved: number; refused: number }>('/api/units/bulk-approve', { ids });

export interface TranslateProgress {
  running: boolean;
  projectId: number | null;
  done: number;
  total: number;
  translated: number;
  flagged: number;
  errors: { chunk: number; message: string }[];
  /** The tail of what opencode wrote, newest last. */
  log: string[];
  /** When the oldest request still out went, epoch ms, or null when none is. */
  waitingSince: number | null;
  /** How many requests are out right now. */
  inFlight: number;
  /** Answers served from what the model already said, rather than bought again. */
  reused: number;
  timeoutMs: number;
  /** Which CLI and model the run actually chose. */
  engine: Engine;
  model: string | null;
  finishedAt: string | null;
  currentChunk?: { current: number; total: number; sample?: string | undefined } | null;
}

export type TranslateScope = 'untranslated' | 'waiting' | 'selected' | 'all';

/** Which CLI does the translating. */
export type Engine = 'opencode' | 'agy' | 'claude' | 'codex';

export interface AiAgent {
  id: string;
  name: string;
  command: string;
  model: string;
  defaultModel: string;
  enabled: boolean;
  icon: string;
  bashSample: string;
  description: string;
}

export const fetchAiSettings = () =>
  json<{ agents: AiAgent[] }>('/api/settings/ai');

export const saveAiSettings = (agents: AiAgent[]) =>
  post<{ ok: true; agents: AiAgent[] }>('/api/settings/ai', { agents }, 'AI ayarları kaydedildi');

export const startTranslation = (
  projectId: number,
  options: {
    agent?: string;
    model?: string;
    scope?: TranslateScope;
    ids?: number[];
    engine?: Engine;
  } = {},
) =>
  post<TranslateProgress>(`/api/projects/${projectId}/translate`, options, 'Çeviri başlatıldı');

export const translateProgress = (projectId: number) =>
  json<TranslateProgress>(`/api/projects/${projectId}/translate`);

export const stopTranslation = (projectId: number) =>
  json<TranslateProgress>(
    `/api/projects/${projectId}/translate`,
    { method: 'DELETE' },
    'Çeviri durduruldu',
  );

export const setSourceTags = (id: number, tagIds: number[]) =>
  post<{ ok: true }>(`/api/sources/${id}/tags`, { tagIds }, 'Etiketler kaydedildi');

export const bulkDeleteSources = (ids: number[]) =>
  post<{ removed: number }>('/api/sources/bulk-delete', { ids }, 'Kaynaklar kaldırıldı');

export const bulkTagSources = (ids: number[], change: { add?: number[]; remove?: number[] }) =>
  post<{ changed: number }>('/api/sources/bulk-tags', { ids, ...change });

export interface ImportSourcesResult {
  added: Array<{ id: number; name: string; strings: number }>;
  skipped: Array<{ id: number; name: string; reason: string }>;
  errors: Array<{ id: number; name: string; error: string }>;
}

export const importSourcesToProjects = (ids: number[]) =>
  post<ImportSourcesResult>('/api/sources/import-to-projects', { ids }, 'Projeler aktarıldı');

export interface SingleProposal {
  id: number;
  translation?: string;
  translationPlural?: string;
  from?: 'glossary' | 'memory' | 'model';
  reason?: string;
}

export async function requestSingleProposal(
  projectPath: string | undefined,
  unit: { id: number; msgid: string; msgidPlural?: string | null; msgctxt?: string | null },
  engine?: string,
): Promise<SingleProposal> {
  const { job } = await post<{ job: string }>('/api/propose', {
    projectPath,
    engine,
    items: [
      {
        id: unit.id,
        source: unit.msgid,
        ...(unit.msgidPlural ? { sourcePlural: unit.msgidPlural } : {}),
        ...(unit.msgctxt ? { context: unit.msgctxt } : {}),
      },
    ],
  });

  const pollInterval = 1000;
  for (let i = 0; i < 60; i++) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    const state = await json<{ done: boolean; error?: string; result?: { proposals: SingleProposal[] } }>(
      `/api/jobs/${job}`,
    );
    if (!state.done) continue;
    if (state.error) throw new Error(state.error);
    const proposal = state.result?.proposals?.[0];
    if (!proposal) throw new Error('Modelden bir öneri gelmedi.');
    return proposal;
  }
  throw new Error('AI öneri zaman aşımına uğradı.');
}

export interface WporgSettings {
  cookie: string;
}

export interface WporgSessionVerification {
  valid: boolean;
  username?: string | undefined;
  displayName?: string | undefined;
  error?: string | undefined;
}

export interface PublishResult {
  ok: boolean;
  message: string;
  exported: number;
  withheld: number;
}

export const fetchWporgSettings = () => json<WporgSettings>('/api/settings/wporg');

export const saveWporgSettings = (cookie: string) =>
  post<{ ok: true }>('/api/settings/wporg', { cookie }, 'WordPress.org çerezi kaydedildi');

export const verifyWporgSession = (cookie?: string) =>
  post<WporgSessionVerification>('/api/settings/wporg/verify', { cookie });

export const publishToWporg = (
  projectId: number,
  options?: { ids?: number[]; filter?: string; status?: 'current' | 'waiting' },
) =>
  post<PublishResult>(`/api/projects/${projectId}/publish`, options ?? {}, 'wp.org’a yayınlandı');

export interface QueueWorkerConfig {
  family?: 'plugin' | 'theme' | 'all' | undefined;
  mode?: 'dry_run' | 'apply' | undefined;
  autoApprove?: boolean | undefined;
  autoReject?: boolean | undefined;
  engine?: string | undefined;
  model?: string | undefined;
  pauseMs?: number | undefined;
}

export interface QueueLog {
  time: string;
  level: 'info' | 'warn' | 'error' | 'success';
  text: string;
}

export interface QueueWorkerState {
  running: boolean;
  phase: 'idle' | 'scanning' | 'working' | 'done' | 'stopped' | 'error';
  mode: 'dry_run' | 'apply';
  targetsTotal: number;
  targetsCompleted: number;
  currentProject: string;
  currentQueue: string;
  rowsTotal: number;
  rowsProcessed: number;
  approved: number;
  rejected: number;
  skipped: number;
  logs: QueueLog[];
  error?: string | undefined;
}

export interface QueueTargetPreview {
  family: 'plugin' | 'theme';
  slug: string;
  name: string;
  subProject?: string | undefined;
  projectPath: string;
  queueUrl: string;
  status: 'waiting' | 'fuzzy';
  count: number;
}

export const getQueueWorkerStatus = () =>
  json<QueueWorkerState>('/api/queue-worker/status');

export const startQueueWorker = (config: QueueWorkerConfig) =>
  post<QueueWorkerState>('/api/queue-worker/start', config, 'Kuyruk inceleme başlatıldı');

export const stopQueueWorker = () =>
  post<QueueWorkerState>('/api/queue-worker/stop', {}, 'Kuyruk inceleme durduruldu');

export const scanQueuePreview = (family?: 'plugin' | 'theme' | 'all') =>
  post<{ targets: QueueTargetPreview[] }>('/api/queue-worker/scan', { family: family ?? 'all' });

// AI Memory types & client
export interface MemoryEntry {
  id: number;
  kind: 'translation' | 'judgement';
  keyHash: string;
  sourceText: string;
  answer: any;
  model: string | null;
  uses: number;
  usedAt: string | null;
  createdAt: string;
}

export interface MemoryCounts {
  translation: number;
  judgement: number;
  reuses: number;
}

export interface MemoryResponse {
  total: number;
  entries: MemoryEntry[];
  counts: MemoryCounts;
}

export async function fetchMemory(params?: {
  kind?: 'translation' | 'judgement';
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<MemoryResponse> {
  const query = new URLSearchParams();
  if (params?.kind) query.set('kind', params.kind);
  if (params?.search) query.set('search', params.search);
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.offset) query.set('offset', String(params.offset));
  return json<MemoryResponse>(`/api/memory?${query.toString()}`);
}

export async function deleteMemoryItem(id: number): Promise<void> {
  await del(`/api/memory/${id}`, 'Hafıza kaydı silindi');
}

export async function deleteMemoryBulk(ids: number[]): Promise<void> {
  await post('/api/memory/delete', { ids }, `${ids.length} hafıza kaydı silindi`);
}

export async function clearAllMemory(kind?: 'translation' | 'judgement'): Promise<void> {
  await post('/api/memory/delete', { all: true, kind }, 'Tüm hafıza temizlendi');
}

// System Logs types & client
export interface SystemLog {
  id: number;
  level: 'error' | 'warn' | 'info';
  category: string;
  message: string;
  details: string | null;
  createdAt: string;
}

export interface LogsResponse {
  total: number;
  entries: SystemLog[];
}

export async function fetchLogs(params?: {
  level?: 'error' | 'warn' | 'info';
  category?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<LogsResponse> {
  const query = new URLSearchParams();
  if (params?.level) query.set('level', params.level);
  if (params?.category) query.set('category', params.category);
  if (params?.search) query.set('search', params.search);
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.offset) query.set('offset', String(params.offset));
  return json<LogsResponse>(`/api/logs?${query.toString()}`);
}

export async function clearLogs(): Promise<void> {
  await del('/api/logs', 'Tüm sistem günlükleri temizlendi');
}

