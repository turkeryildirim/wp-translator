import type { Db } from '../db/open.ts';
import { collectTerms } from '../glossary/terminology.ts';
import { askModel } from '../judge/ask.ts';
import { judgeLocally, type Judgement, type Submission } from '../judge/verdict.ts';
import { defaultTagId } from './sources.ts';
import { styleGuideFor } from './tags.ts';
import type { AgyOptions } from '../translate/agy.ts';

export interface JudgeRequest {
  /** e.g. `wp-themes/phlox`. Used to pick the tags; any project may be judged. */
  projectPath?: string;
  items: Submission[];
}

export interface JudgeResult {
  judgements: Judgement[];
  /** How many actually reached the model, after the checks, the glossary and memory. */
  asked: number;
  /** How many came from what the model had already said. */
  reused: number;
}

/**
 * Decide what to do with translations somebody else submitted.
 *
 * The cheap evidence goes first: a quality check that fails settles it, and so
 * does the glossary already holding this wording. Only what is left is put to
 * the model, and only once — repeats come from `ai_memory`.
 */
export async function judgeSubmissions(
  db: Db,
  request: JudgeRequest,
  options: AgyOptions & { signal?: AbortSignal } = {},
): Promise<JudgeResult> {
  const { projectId, tagIds } = scopeFor(db, request.projectPath);
  const settled = new Map<number, Judgement>();
  const open: Submission[] = [];

  for (const item of request.items) {
    const local = judgeLocally(db, item, tagIds);
    if (local) settled.set(item.id, local);
    else open.push(item);
  }

  let asked = 0;
  if (open.length > 0) {
    const styleGuide = styleGuideFor(db, projectId);
    const terms = collectTerms(db, projectId, open.map((item) => item.source));
    const answered = await askModel(db, open, { styleGuide, terms }, options);
    asked = answered.asked;
    for (const judgement of answered.judgements) settled.set(judgement.id, judgement);
  }

  return {
    judgements: request.items.map(
      (item) =>
        settled.get(item.id) ?? {
          id: item.id,
          verdict: 'unknown',
          reason: 'Karar verilemedi.',
        },
    ),
    asked,
    reused: open.length - asked,
  };
}

/**
 * Which tags and which project's rules apply.
 *
 * A project the owner never imported is still judgeable: it falls back to the
 * default tag and the general style guide, which is what a first pass over
 * somebody else's queue needs.
 */
function scopeFor(db: Db, projectPath?: string): { projectId: number; tagIds: number[] } {
  const project = projectPath
    ? (db
        .prepare(`SELECT id FROM projects WHERE project_path = ?`)
        .get(projectPath) as { id: number } | undefined)
    : undefined;

  if (project) {
    const tagIds = db
      .prepare(`SELECT tag_id FROM project_tags WHERE project_id = ?`)
      .all(project.id)
      .map((row) => (row as { tag_id: number }).tag_id);
    if (tagIds.length > 0) return { projectId: project.id, tagIds };
  }

  return { projectId: project?.id ?? 0, tagIds: [defaultTagId(db)] };
}
