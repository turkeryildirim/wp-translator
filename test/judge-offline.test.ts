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
