import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../db/open.ts';
import { questionKey, recall, remember, rulesKey } from '../ai/memory.ts';
import { agyItems, invokeAgy, type AgyOptions } from '../translate/agy.ts';
import { buildJudgePrompt, toJudgeItems, type JudgeContext } from './prompt.ts';
import type { Judgement, Submission } from './verdict.ts';

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

/** The exact question a submission puts to the model, hashed as the memory key. */
export const judgeKey = (submission: Submission): string =>
  questionKey([
    submission.source,
    submission.sourcePlural ?? '',
    submission.translation,
    submission.translationPlural ?? '',
  ]);

/**
 * Ask the model to judge a batch, and turn its answer into judgements.
 *
 * Anything already answered under the same rules is served from memory and never
 * asked again — the same string turns up across project after project. Only agy
 * is used: the reply is a verdict per item and a schema is what keeps that
 * reliable, which opencode cannot enforce.
 */
export async function askModel(
  db: Db,
  submissions: readonly Submission[],
  context: JudgeContext,
  options: AgyOptions & { signal?: AbortSignal } = {},
): Promise<{ judgements: Judgement[]; asked: number }> {
  if (submissions.length === 0) return { judgements: [], asked: 0 };

  const rules = rulesKey(context.styleGuide);
  const answers = new Map<number, Judgement>();
  const toAsk: Submission[] = [];

  for (const submission of submissions) {
    const known = recall<Judgement>(db, 'judgement', judgeKey(submission), rules);
    if (known) answers.set(submission.id, { ...known.answer, id: submission.id });
    else toAsk.push(submission);
  }

  let silence = 'Model bu dizge için yanıt vermedi.';

  if (toAsk.length > 0) {
    const directory = await mkdtemp(join(tmpdir(), 'wp-translator-judge-'));
    const schemaPath = join(directory, 'schema.json');
    let opinions: unknown[] | undefined;

    try {
      await writeFile(schemaPath, JSON.stringify(SCHEMA), 'utf-8');
      const prompt = `${buildJudgePrompt(context)}\n\nJSON:\n${JSON.stringify(toJudgeItems(toAsk))}`;
      opinions = agyItems(await invokeAgy({ ...options, schemaPath, prompt }));
    } catch (problem) {
      // A model that cannot be reached or cannot be read leaves these rows
      // undecided instead of failing the batch: the verdicts the checks and the
      // glossary already settled are worth keeping, and nothing is ever approved
      // on an `unknown`. The reason carries the error so it reaches the row.
      if (options.signal?.aborted) throw problem;
      silence = `Model yanıt vermedi: ${problem instanceof Error ? problem.message : String(problem)}`;
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
          question: { source: submission.source, translation: submission.translation },
          answer: judgement,
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
  };
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
    const expected = opinion.mine && opinion.mine !== submission.translation ? opinion.mine : undefined;
    return {
      id: submission.id,
      verdict: opinion.ok ? 'agreed' : 'flagged',
      reason: opinion.why?.trim() || (opinion.ok ? 'Kurallara uygun.' : 'Model kurallara uymadığını söylüyor.'),
      ...(expected ? { expected } : {}),
    };
  });
}
