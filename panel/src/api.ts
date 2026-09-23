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
