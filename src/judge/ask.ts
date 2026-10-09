import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../db/open.ts';
import { questionKey, recall, remember, rulesKey } from '../ai/memory.ts';
import { agyItems, invokeAgy } from '../translate/agy.ts';
import { collectText, invokeOpencode, jsonArray, providerError } from '../translate/opencode.ts';
import { unescapeEchoedQuotes } from '../text/escapes.ts';
import { buildJudgePrompt, toJudgeItems, type JudgeContext } from './prompt.ts';
import { proposalFor, type Judgement, type Submission } from './verdict.ts';

/** One verdict as the model returns it. */
export interface Opinion {
  i: number;
  ok: boolean;
  why?: string;
  mine?: string;
}

const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i: { type: 'integer' },
          ok: { type: 'boolean' },
          why: { type: 'string' },
          mine: { type: 'string' },
        },
        required: ['i', 'ok'],
      },
    },
  },
  required: ['items'],
};

/**
 * The exact question a submission puts to the model, hashed as the memory key.
 *
 * `msgctxt` is part of the question because it is part of what the model is shown
 * and changes the answer: `Draft` as a post status and `Draft` as a verb are two
 * questions. It is the only key in the tool that reads a context — matching never
 * does — and that is why: this one is a model's opinion, not a glossary lookup.
 */
export const judgeKey = (submission: Submission): string =>
  questionKey([
    submission.source,
    submission.sourcePlural ?? '',
    submission.context ?? '',
    submission.translation,
    submission.translationPlural ?? '',
  ]);

export interface AskResult {
  judgements: Judgement[];
  /** How many reached the model, rather than its memory. */
  asked: number;
  /**
   * Why the provider could not be asked at all, where that is what happened.
   *
   * An `unknown` verdict says nothing about which of two things went wrong: the
   * model answered the batch and skipped this one id, or there was no answer
   * because the CLI is out of quota and hanging. A caller walking thousands of
   * rows has to tell them apart — the first is one row to leave alone, the second
   * is a reason to stop — and it cannot do that from a sentence, nor from "every
   * verdict is unknown", because the glossary settles rows in the same batch.
   */
  unreachable?: string;
}

export interface AskOptions {
  /** Which CLI to ask. agy enforces the answer's shape; opencode is parsed. */
  engine?: 'opencode' | 'agy';
  model?: string;
  /** opencode only: the tool-free agent. */
  agent?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Ask the model to judge a batch, and turn its answer into judgements.
 *
 * Anything already answered under the same rules is served from memory and never
 * asked again — the same string turns up across project after project. Either CLI
 * can be asked: agy is given a schema and hands back the items parsed, opencode
 * cannot be told a shape so its text is scraped for the array.
 */
export async function askModel(
  db: Db,
  submissions: readonly Submission[],
  context: JudgeContext,
  options: AskOptions = {},
): Promise<AskResult> {
  if (submissions.length === 0) return { judgements: [], asked: 0 };

  const rules = rulesKey(context.styleGuide);
  const answers = new Map<number, Judgement>();
  const toAsk: Submission[] = [];

  for (const submission of submissions) {
    const known = recall<Judgement>(db, 'judgement', judgeKey(submission), rules);
    if (known) answers.set(submission.id, settle(submission, known.answer));
    else toAsk.push(submission);
  }

  let silence = 'Model bu dizge için yanıt vermedi.';
  let unreachable: string | undefined;

  if (toAsk.length > 0) {
    const directory = await mkdtemp(join(tmpdir(), 'wp-translator-judge-'));
    const schemaPath = join(directory, 'schema.json');
    let opinions: unknown[] | undefined;

    try {
      await writeFile(schemaPath, JSON.stringify(SCHEMA), 'utf-8');
      const prompt = `${buildJudgePrompt(context)}\n\nJSON:\n${JSON.stringify(toJudgeItems(toAsk))}`;
      opinions = await opinionsFrom(prompt, schemaPath, options);
    } catch (problem) {
      // A model that cannot be reached or cannot be read leaves these rows
      // undecided instead of failing the batch: the verdicts the checks and the
      // glossary already settled are worth keeping, and nothing is ever approved
      // on an `unknown`. The reason carries the error so it reaches the row.
      if (options.signal?.aborted) throw problem;
      unreachable = problem instanceof Error ? problem.message : String(problem);
      silence = `Model yanıt vermedi: ${unreachable}`;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    for (const judgement of opinions ? readOpinions(toAsk, opinions) : []) {
      answers.set(judgement.id, judgement);
      const submission = toAsk.find((candidate) => candidate.id === judgement.id);
      // An unknown is not an answer; keeping it would cache a silence.
      if (submission && judgement.verdict !== 'unknown') {
        remember(db, {
          kind: 'judgement',
          keyHash: judgeKey(submission),
          rulesHash: rules,
          sourceText: submission.source,
          question: {
            source: submission.source,
            ...(submission.context ? { context: submission.context } : {}),
            translation: submission.translation,
          },
          answer: forget(judgement),
          model: options.model ?? null,
        });
      }
    }
  }

  return {
    judgements: submissions.map(
      (submission) =>
        answers.get(submission.id) ?? { id: submission.id, verdict: 'unknown', reason: silence },
    ),
    asked: toAsk.length,
    ...(unreachable ? { unreachable } : {}),
  };
}

/**
 * A judgement with its proposal worked out for this submission.
 *
 * `proposal` is `expected` gated by the quality checks, so it is derived and
 * never taken from what was stored: a remembered opinion has to be re-gated
 * against today's checks, and one remembered before proposals existed carries
 * none at all.
 */
function settle(submission: Submission, answer: Judgement): Judgement {
  const { proposal: _derived, expected: _asStored, ...rest } = answer;
  const expected = answer.expected
    ? unescapeEchoedQuotes(submission.source, answer.expected)
    : undefined;
  const proposal = expected ? proposalFor(submission, expected) : undefined;
  return {
    ...rest,
    id: submission.id,
    ...(expected ? { expected } : {}),
    ...(proposal ? { proposal } : {}),
  };
}

/**
 * Put the question to whichever CLI was asked for.
 *
 * agy is given the schema and answers in it. opencode has no such flag, so the
 * prompt's own output rules are all there is and the array is cut out of the text —
 * the same scraping its translations go through.
 */
async function opinionsFrom(
  prompt: string,
  schemaPath: string,
  options: AskOptions,
): Promise<unknown[]> {
  if (options.engine === 'opencode') {
    const stdout = await invokeOpencode({
      ...(options.model ? { model: options.model } : {}),
      ...(options.agent ? { agent: options.agent } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      prompt,
    });

    const text = collectText(stdout);
    if (!text.trim()) {
      const reported = providerError(stdout);
      throw new Error(reported ? `opencode: ${reported}` : 'opencode boş yanıt verdi.');
    }
    return jsonArray(text);
  }

  return agyItems(
    await invokeAgy({
      ...(options.model ? { model: options.model } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      schemaPath,
      prompt,
    }),
  );
}

/**
 * Match opinions back to submissions by the id that was sent.
 *
 * A submission the model said nothing about stays `unknown` rather than being
 * assumed good: silence is not agreement, and this decides whether somebody
 * else's work gets approved.
 */
export function readOpinions(
  submissions: readonly Submission[],
  items: readonly unknown[],
): Judgement[] {
  const byIndex = new Map<number, Opinion>();
  for (const raw of items) {
    const item = raw as { i?: unknown; ok?: unknown; why?: unknown; mine?: unknown };
    if (typeof item.i !== 'number' || typeof item.ok !== 'boolean') continue;
    byIndex.set(item.i, {
      i: item.i,
      ok: item.ok,
      ...(typeof item.why === 'string' ? { why: item.why } : {}),
      ...(typeof item.mine === 'string' ? { mine: item.mine } : {}),
    });
  }

  return submissions.map((submission, index) => {
    const opinion = byIndex.get(index);
    if (!opinion) {
      return { id: submission.id, verdict: 'unknown', reason: 'Model bu dizge için yanıt vermedi.' };
    }
    const mine = opinion.mine ? unescapeEchoedQuotes(submission.source, opinion.mine) : undefined;
    const expected = mine && mine !== submission.translation ? mine : undefined;
    const proposal = expected ? proposalFor(submission, expected) : undefined;
    return {
      id: submission.id,
      verdict: opinion.ok ? 'agreed' : 'flagged',
      reason: opinion.why?.trim() || (opinion.ok ? 'Kurallara uygun.' : 'Model kurallara uymadığını söylüyor.'),
      ...(expected ? { expected } : {}),
      ...(proposal ? { proposal } : {}),
    };
  });
}

/** The opinion alone, without the proposal derived from it. */
const forget = (judgement: Judgement): Judgement => {
  const { proposal: _derived, ...opinion } = judgement;
  return opinion;
};
