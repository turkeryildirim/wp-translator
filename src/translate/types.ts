import type { Term } from '../glossary/terminology.ts';

/** One string handed to the model, as it appears in the JSON payload. */
export interface RequestItem {
  /** Opaque id. Results are matched back by this and never by position. */
  i: number;
  /** Source string. */
  s: string;
  /** `msgctxt`, where the catalogue has one. */
  c?: string;
  /** English plural form, where the string has one. */
  p?: string;
  /** Where the string appears: admin, frontend, both. Omitted when unknown. */
  u?: string;
  /** Capped source excerpt, only for strings whose surface could not be derived. */
  x?: string;
}

/** One translation coming back. */
export interface ResponseItem {
  i: number;
  t: string;
  /** Plural translation, where `p` was given. */
  tp?: string;
}

export interface TranslationContext {
  /** The general style guide plus any per-tag rules. */
  styleGuide: string;
  /** Glossary terms appearing in this batch. */
  terms: readonly Term[];
  project?: {
    name?: string;
    description?: string;
    readme?: string;
  };
}

export interface TranslationRequest {
  items: readonly RequestItem[];
  context: TranslationContext;
}

/**
 * A translation provider. The interface exists so the model choice lives in
 * opencode's configuration rather than in this codebase.
 */
export interface TranslationProvider {
  readonly name: string;
  translate(request: TranslationRequest, signal?: AbortSignal): Promise<ResponseItem[]>;
}
