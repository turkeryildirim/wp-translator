import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { sourceHash } from '../src/glossary/key.ts';

vi.mock('../src/translate/agy.ts', () => ({
  invokeAgy: () => Promise.reject(new Error('agy did not answer within 120s')),
  agyItems: () => {
    throw new Error('not reached');
  },
}));

const { judgeSubmissions } = await import('../src/server/judge.ts');

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
  const tagId = (db.prepare(`SELECT id FROM tags WHERE name = 'wordpress'`).get() as { id: number })
    .id;
  db.prepare(
    `INSERT INTO glossary_entries (source_hash, source_text, msgctxt, tag_id, translation, origin)
     VALUES (?, 'Save', NULL, ?, 'Kaydet', 'trusted')`,
  ).run(sourceHash('Save', undefined), tagId);
});

describe('judging when the model cannot be reached', () => {
  it('keeps the verdicts the checks and the glossary already settled', async () => {
    // The whole batch used to fail with the provider, which threw away the two
    // rows that needed no model and stopped the run on its first page.
    const result = await judgeSubmissions(db, {
      items: [
        { id: 1, source: 'Save', translation: 'Kaydet' },
        { id: 2, source: 'Use %1$s and %2$s', translation: 'Yalnızca %s kullan' },
        { id: 3, source: 'Sharing docs', translation: 'Paylaşma belgeleri' },
      ],
    });

    expect(result.judgements.map((judgement) => judgement.verdict)).toEqual([
      'exact',
      'flagged',
      'unknown',
    ]);
  });

  it('says the provider was unreachable, beside rows that were settled anyway', async () => {
    // A caller walking thousands of rows has to stop on a CLI that is out of
    // quota, and cannot see one from the verdicts: measured against a dead plan,
    // the batch came back with one `unknown` reading *Insufficient balance*
    // beside a row the glossary had settled, so "every verdict is unknown" would
    // have walked straight past it.
    const result = await judgeSubmissions(db, {
      items: [
        { id: 1, source: 'Save', translation: 'Kaydet' },
        { id: 3, source: 'Sharing docs', translation: 'Paylaşma belgeleri' },
      ],
    });

    expect(result.judgements[0]!.verdict).toBe('exact');
    expect(result.unreachable).toMatch(/did not answer within 120s/);
  });

  it('says nothing about reachability when the model was never needed', async () => {
    const result = await judgeSubmissions(db, {
      items: [{ id: 1, source: 'Save', translation: 'Kaydet' }],
    });

    expect(result).not.toHaveProperty('unreachable');
  });

  it('carries the provider’s own error into the reason', async () => {
    // The verdict reaches a row as an annotation, so the reason is the only place
    // the owner can learn why nothing was decided.
    const result = await judgeSubmissions(db, {
      items: [{ id: 3, source: 'Sharing docs', translation: 'Paylaşma belgeleri' }],
    });

    expect(result.judgements[0]!.reason).toMatch(/did not answer within 120s/);
  });

  it('never approves on an unreachable model', async () => {
    const result = await judgeSubmissions(db, {
      items: [{ id: 3, source: 'Sharing docs', translation: 'Paylaşma belgeleri' }],
    });

    expect(result.judgements[0]!.verdict).not.toBe('exact');
    expect(result.judgements[0]!.verdict).not.toBe('agreed');
  });
});

describe('a judgement served from memory', () => {
  const submission = {
    id: 7,
    source: 'Secure and integrated',
    translation: 'Güvenli ve Entegre',
  };

  it('carries a clickable proposal even when none was stored with it', async () => {
    const { judgeKey } = await import('../src/judge/ask.ts');
    const { rulesKey, remember } = await import('../src/ai/memory.ts');
    const { styleGuideFor } = await import('../src/server/tags.ts');

    remember(db, {
      kind: 'judgement',
      keyHash: judgeKey(submission),
      rulesHash: rulesKey(styleGuideFor(db, 0)),
      sourceText: submission.source,
      question: { source: submission.source, translation: submission.translation },
      answer: {
        id: 999,
        verdict: 'flagged',
        reason: 'Cümle düzeni kullanılmalı.',
        expected: 'Güvenli ve entegre',
      },
    });

    const result = await judgeSubmissions(db, { items: [submission] });

    expect(result.asked).toBe(0);
    expect(result.judgements[0]).toMatchObject({
      id: 7,
      verdict: 'flagged',
      proposal: 'Güvenli ve entegre',
    });
  });

  it('drops a stored proposal that today’s checks refuse', async () => {
    // The checks are what make a proposal safe to apply on one click, so a
    // remembered one is re-gated rather than trusted. The submission itself has
    // to pass, or the checks settle it before memory is ever consulted.
    const placeholder = { id: 8, source: 'Use %s now', translation: 'Şimdi %s kullan' };
    const { judgeKey } = await import('../src/judge/ask.ts');
    const { rulesKey, remember } = await import('../src/ai/memory.ts');
    const { styleGuideFor } = await import('../src/server/tags.ts');

    remember(db, {
      kind: 'judgement',
      keyHash: judgeKey(placeholder),
      rulesHash: rulesKey(styleGuideFor(db, 0)),
      sourceText: placeholder.source,
      question: { source: placeholder.source, translation: placeholder.translation },
      answer: {
        id: 8,
        verdict: 'flagged',
        reason: 'Başka bir karşılık daha iyi.',
        expected: 'Şimdi kullan',
        proposal: 'Şimdi kullan',
      },
    });

    const result = await judgeSubmissions(db, { items: [placeholder] });

    expect(result.judgements[0]!.expected).toBe('Şimdi kullan');
    expect(result.judgements[0]).not.toHaveProperty('proposal');
  });

  it('is not served to the same string under another context', async () => {
    // The context is part of what the model was shown, so it is part of the
    // question. Without it the answer about a post's status would settle the
    // verb, and a model that was never asked would appear to have agreed.
    const { judgeKey } = await import('../src/judge/ask.ts');
    const status = { id: 9, source: 'Draft', context: 'post status', translation: 'Taslak' };
    const verb = { id: 9, source: 'Draft', context: 'verb', translation: 'Taslak' };

    expect(judgeKey(status)).not.toBe(judgeKey(verb));
    expect(judgeKey(status)).not.toBe(judgeKey({ id: 9, source: 'Draft', translation: 'Taslak' }));
  });
});
