import { notify } from './notify.ts';
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

export interface UnitDetail {
  refs: string | null;
  extractedComments: string | null;
  usageSurface: string | null;
  terms: { source: string; readings: TermReading[] }[];
}

/**
 * Every call to the server goes through here, which is why the reporting lives
 * here too. Components were throwing into an unhandled rejection: a write that
 * failed left the screen looking exactly like a write that worked.
 *
 * @param label names the write for the corner message; a read passes none.
 */
const json = async <T>(input: string, init?: RequestInit, label?: string): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (problem) {
    // The server is a local process the owner starts by hand.
    notify('error', `Sunucuya ulaşılamadı. Çalışıyor mu? (${describe(problem)})`);
    throw problem;
  }

  if (!response.ok) {
    notify('error', `${label ?? 'İstek'} başarısız: ${await reason(response)}`);
    throw new Error(`${response.status} ${response.statusText}`);
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
export type BulkAction = 'approve' | 'clear' | 'glossary';

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

export const searchGlossary = (params: Record<string, string>) =>
  json<{ rows: GlossaryEntry[]; total: number }>(`/api/glossary?${new URLSearchParams(params)}`);
export interface EntryDetail {
  sources: EntrySource[];
  /** Where this translation has been seen. Informational only. */
  contexts: string[];
}

export const entryDetail = (id: number) => json<EntryDetail>(`/api/glossary/${id}`);
export const updateEntry = (
  id: number,
  translation: string,
  translationPlural?: string,
) =>
  post<{ entry: GlossaryEntry; sourceWordingReturns: boolean }>(
    `/api/glossary/${id}`,
    translationPlural === undefined ? { translation } : { translation, translationPlural },
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
  timeoutMs: number;
  finishedAt: string | null;
}

export type TranslateScope = 'untranslated' | 'waiting' | 'selected' | 'all';

/** Which CLI does the translating. */
export type Engine = 'opencode' | 'agy';

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
