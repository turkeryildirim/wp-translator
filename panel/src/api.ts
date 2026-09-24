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
  failures: CheckFailure[];
  candidates: Candidate[];
  structured: boolean;
}

export interface Project {
  id: number;
  name: string | null;
  projectPath: string;
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

const json = async <T>(input: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(input, init);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
};

export const listProjects = () => json<Project[]>('/api/projects');

export const listUnits = (projectId: number, params: Record<string, string> = {}) =>
  json<Unit[]>(`/api/projects/${projectId}/units?${new URLSearchParams(params)}`);

export const unitDetail = (unitId: number) => json<UnitDetail>(`/api/units/${unitId}/detail`);

export const saveUnit = (unitId: number, edit: { msgstr?: string; msgstrPlural?: string }) =>
  json<{ unit: Unit; blocked?: CheckFailure[] }>(`/api/units/${unitId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(edit),
  });

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
}

export interface EntrySource {
  label: string | null;
  projectPath: string;
  rank: number;
  translation: string;
}

const post = <T>(url: string, body: unknown) =>
  json<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

export const listTags = () => json<Tag[]>('/api/tags');

export const listSources = () => json<TrustedSource[]>('/api/sources');
export const addSource = (url: string, tagIds: number[], label?: string) =>
  post<{ id: number }>('/api/sources', { url, tagIds, label });
export const reorderSources = (ids: number[]) => post<{ ok: true }>('/api/sources/reorder', { ids });
export const startSync = () => post<SyncProgress>('/api/sources/sync', {});
export const syncProgress = () => json<SyncProgress>('/api/sources/sync');

export const searchGlossary = (params: Record<string, string>) =>
  json<{ rows: GlossaryEntry[]; total: number }>(`/api/glossary?${new URLSearchParams(params)}`);
export const entrySources = (id: number) => json<EntrySource[]>(`/api/glossary/${id}`);
export const updateEntry = (id: number, translation: string) =>
  post<{ entry: GlossaryEntry; overwrittenOnNextSync: boolean }>(`/api/glossary/${id}`, {
    translation,
  });

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
  match: { filled: number; ambiguous: number; unmatched: number };
  suggestedTags: string[];
}

export const createTag = (name: string) => post<{ id: number }>('/api/tags', { name });
export const renameTag = (id: number, name: string) => post<{ ok: true }>(`/api/tags/${id}`, { name });
export const previewMerge = (from: number, to: number) =>
  post<MergePreview>('/api/tags/merge', { from, to, preview: true });
export const mergeTags = (from: number, to: number, policy: 'keep-target' | 'take-source') =>
  post<MergePreview & { policy: string }>('/api/tags/merge', { from, to, policy });

export const listStyleRules = () => json<StyleRule[]>('/api/style-rules');
export const saveStyleRule = (tagId: number | null, body: string) =>
  post<{ ok: true }>('/api/style-rules', { tagId, body });

export const addProject = (url: string, tagIds: number[]) =>
  post<AddProjectResult>('/api/projects', { url, tagIds });
export const removeProject = (id: number) =>
  json<{ ok: true }>(`/api/projects/${id}`, { method: 'DELETE' });

export const bulkApprove = (ids: number[]) =>
  post<{ approved: number; refused: number }>('/api/units/bulk-approve', { ids });

export interface TranslateProgress {
  running: boolean;
  projectId: number | null;
  done: number;
  total: number;
  translated: number;
  flagged: number;
  errors: { chunk: number; message: string }[];
  finishedAt: string | null;
}

export const startTranslation = (projectId: number, options: { agent?: string; model?: string } = {}) =>
  post<TranslateProgress>(`/api/projects/${projectId}/translate`, options);

export const translateProgress = (projectId: number) =>
  json<TranslateProgress>(`/api/projects/${projectId}/translate`);

export const setSourceTags = (id: number, tagIds: number[]) =>
  post<{ ok: true }>(`/api/sources/${id}/tags`, { tagIds });

export const bulkDeleteSources = (ids: number[]) =>
  post<{ removed: number }>('/api/sources/bulk-delete', { ids });

export const bulkTagSources = (ids: number[], change: { add?: number[]; remove?: number[] }) =>
  post<{ changed: number }>('/api/sources/bulk-tags', { ids, ...change });
