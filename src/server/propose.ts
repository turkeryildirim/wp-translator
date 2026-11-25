import type { Db } from '../db/open.ts';
import { collectTerms } from '../glossary/terminology.ts';
import { glossaryWordings, proposalFor, refusalFor } from '../judge/verdict.ts';
import { rememberTranslations, reshape, splitByMemory, type TranslationMemoryScope } from '../ai/translationMemory.ts';
import type { RequestItem, ResponseItem, TranslationProvider } from '../translate/types.ts';
import { chunk, providerFor, type TranslateOptions } from './translate.ts';
import { scopeFor } from './judge.ts';
import { styleGuideFor } from './tags.ts';

/** One string with no translation yet, as the review page presents it. */
export interface ProposeItem {
  /** GlotPress's original id, which is what the save route takes. */
  id: number;
  source: string;
  sourcePlural?: string;
  context?: string;
}

export interface ProposeRequest {
  /** e.g. `wp-themes/astra`. Picks the tags and the style guide; any project may be asked about. */
  projectPath?: string;
  items: ProposeItem[];
}

export interface Proposal {
  id: number;
  /** A wording the quality checks passed. Absent when none is offered. */
  translation?: string;
  translationPlural?: string;
  /** Where it came from, so the row can say whether a human approved it. */
  from?: 'glossary' | 'memory' | 'model';
  /** Why nothing is offered, when nothing is. */
  reason?: string;
}

export interface ProposeResult {
  proposals: Proposal[];
  /** How many reached the model, after the glossary and memory. */
  asked: number;
  /** How many came from what the model had already said. */
  reused: number;
}

/**
 * Translate strings nobody has translated yet, for a page the owner is looking at.
 *
 * The same order of evidence as everywhere else: the glossary first, because a
 * human approved it upstream; then what the model has already been asked; then the
 * model. Nothing is offered that the quality checks refuse — a proposal is applied
 * to a live row on one click.
 */
export async function proposeTranslations(
  db: Db,
  request: ProposeRequest,
  options: TranslateOptions & { signal?: AbortSignal } = {},
): Promise<ProposeResult> {
  const { projectId, tagIds } = scopeFor(db, request.projectPath);
  const settled = new Map<number, Proposal>();
  const open: ProposeItem[] = [];

  for (const item of request.items) {
    const fromGlossary = glossaryProposal(db, item, tagIds);
    if (fromGlossary) settled.set(item.id, fromGlossary);
    else open.push(item);
  }

  let asked = 0;
  let reused = 0;

  if (open.length > 0) {
    const styleGuide = styleGuideFor(db, projectId);
    const items: RequestItem[] = open.map((item, index) => ({
      i: index,
      s: item.source,
      ...(item.sourcePlural ? { p: item.sourcePlural } : {}),
      ...(item.context ? { c: item.context } : {}),
    }));

    const send: TranslationProvider = options.provider ?? providerFor(options, () => {});
    const batches = chunk(
      items.map((item) => ({ msgid: item.s, msgidPlural: item.p ?? null, item })),
      options.chunkSize ?? 10,
      options.chunkChars ?? 2_000,
    );
    for (const batch of batches) {
      const batchItems = batch.map((entry) => entry.item);
      const context = { styleGuide, terms: collectTerms(db, projectId, batchItems.map((item) => item.s)) };
      const memoryScope: TranslationMemoryScope = {
        context, provider: send.name, model: options.model ?? null, agent: options.agent,
      };
      const memory = splitByMemory(db, batchItems, memoryScope);
      reused += memory.known.size;
      for (const [index, answer] of memory.known) {
        settled.set(open[index]!.id, judgeWording(open[index]!, answer, 'memory'));
      }
      if (memory.ask.length > 0) {
        asked += memory.ask.length;
        const answers = await ask(db, memory.ask, batchItems, memoryScope, send, options.signal);
        for (const answer of answers) {
          const item = open[answer.i];
          if (item) settled.set(item.id, judgeWording(item, answer, 'model'));
        }
      }
    }
  }

  return {
    proposals: request.items.map(
      (item) =>
        settled.get(item.id) ?? { id: item.id, reason: 'Karşılık bulunamadı.' },
    ),
    asked,
    reused,
  };
}

/**
 * Ask the provider, in chunks bounded the same way a project's run bounds them.
 *
 * A failed chunk leaves its strings without a proposal rather than failing the
 * page: the rest of the batch is worth keeping and nothing is applied unasked.
 */
async function ask(
  db: Db,
  toAsk: readonly RequestItem[],
  original: readonly RequestItem[],
  memoryScope: TranslationMemoryScope,
  send: TranslationProvider,
  signal?: AbortSignal,
): Promise<ResponseItem[]> {
  try {
    const reply = await send.translate({ items: toAsk, context: memoryScope.context }, signal);
    rememberTranslations(db, toAsk, reply, memoryScope);
    return reshape(original, reply);
  } catch (problem) {
    if (signal?.aborted) throw problem;
    // Other batches can still provide proposals.
    return [];
  }
}

/** The glossary's own wording, when it holds exactly one and the checks pass it. */
function glossaryProposal(db: Db, item: ProposeItem, tagIds: readonly number[]): Proposal | null {
  const submission = { id: item.id, source: item.source, translation: '', ...pluralOf(item) };
  const known = glossaryWordings(db, submission, tagIds);
  if (known.length !== 1) return null;

  const wording = known[0]!;
  const translation = proposalFor(submission, wording.translation, wording.plural ?? undefined);
  if (!translation) return null;

  return {
    id: item.id,
    translation,
    ...(wording.plural ? { translationPlural: wording.plural } : {}),
    from: 'glossary',
  };
}

/** A wording is only offered when the checks pass it; otherwise they say why. */
function judgeWording(
  item: ProposeItem,
  answer: ResponseItem,
  from: 'memory' | 'model',
): Proposal {
  const submission = { id: item.id, source: item.source, translation: '', ...pluralOf(item) };
  const refusal = refusalFor(submission, answer.t, answer.tp);

  if (refusal) return { id: item.id, reason: refusal };

  return {
    id: item.id,
    translation: answer.t,
    ...(answer.tp ? { translationPlural: answer.tp } : {}),
    from,
  };
}

/** The plural half of a source, spread into a submission only when there is one. */
const pluralOf = (item: ProposeItem) =>
  item.sourcePlural ? { sourcePlural: item.sourcePlural } : {};
