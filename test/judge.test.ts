import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { judgeLocally } from '../src/judge/verdict.ts';
import { readOpinions } from '../src/judge/ask.ts';
import { sourceHash } from '../src/glossary/key.ts';

let db: Db;
let tagId: number;

const glossary = (source: string, translation: string): void => {
  db.prepare(
    `INSERT INTO glossary_entries (source_hash, source_text, msgctxt, tag_id, translation, origin)
     VALUES (?, ?, NULL, ?, ?, 'trusted')`,
  ).run(sourceHash(source, undefined), source, tagId, translation);
};

const submission = (source: string, translation: string) => ({ id: 1, source, translation });

beforeEach(() => {
  db = openDb(':memory:');
  // The seed already creates this tag; the glossary's entries live under it.
  tagId = (db.prepare(`SELECT id FROM tags WHERE name = 'wordpress'`).get() as { id: number }).id;
});

describe('judging without a model', () => {
  it('approves what the glossary already says', () => {
    glossary('Save', 'Kaydet');

    expect(judgeLocally(db, submission('Save', 'Kaydet'), [tagId])).toMatchObject({
      verdict: 'exact',
    });
  });

  it('flags an objective defect whatever the glossary thinks', () => {
    // bbPress ships this on a string GlotPress calls fuzzy: two placeholders in
    // the source, one in the translation. No model is needed to see it.
    const verdict = judgeLocally(
      db,
      submission('Use %1$s and %2$s', 'Yalnızca %s kullan'),
      [tagId],
    );

    expect(verdict?.verdict).toBe('flagged');
    expect(verdict?.reason).toMatch(/placeholder/i);
  });

  it('flags a wording the glossary contradicts, and says what it holds', () => {
    glossary('Save', 'Kaydet');

    expect(judgeLocally(db, submission('Save', 'Sakla'), [tagId])).toMatchObject({
      verdict: 'flagged',
      expected: 'Kaydet',
    });
  });

  it('leaves the rest for the model rather than guessing', () => {
    expect(judgeLocally(db, submission('Unheard of', 'Hiç duyulmamış'), [tagId])).toBeNull();
  });

  it('checks the whitespace the glossary no longer stores', () => {
    // The glossary keeps the words; a submission that loses the source's padding
    // is still a defect and is caught here.
    glossary('Save', 'Kaydet');

    expect(judgeLocally(db, submission('Save ', 'Kaydet'), [tagId])).toMatchObject({
      verdict: 'flagged',
    });
  });
});

describe('what reached the model', () => {
  it('counts only the questions actually asked', async () => {
    // A submission the checks or the glossary settled never reaches the model,
    // and neither does one the store already answered.
    const { judgeSubmissions } = await import('../src/server/judge.ts');
    glossary('Save', 'Kaydet');

    const out = await judgeSubmissions(db, {
      items: [
        { id: 1, source: 'Save', translation: 'Kaydet' },
        { id: 2, source: 'Use %1$s', translation: 'Yalnızca' },
      ],
    });

    expect(out.asked).toBe(0);
    expect(out.reused).toBe(0);
    expect(out.judgements.map((j) => j.verdict)).toEqual(['exact', 'flagged']);
  });
});

describe('reading the model’s opinions', () => {
  const two = [
    { id: 10, source: 'One', translation: 'Bir' },
    { id: 20, source: 'Two', translation: 'İki' },
  ];

  it('matches opinions back by the id that was sent, not by order', () => {
    const out = readOpinions(two, [
      { i: 1, ok: false, why: 'Anlam yanlış.', mine: 'İkinci' },
      { i: 0, ok: true },
    ]);

    expect(out).toEqual([
      { id: 10, verdict: 'agreed', reason: 'Kurallara uygun.' },
      { id: 20, verdict: 'flagged', reason: 'Anlam yanlış.', expected: 'İkinci' },
    ]);
  });

  it('treats silence as unknown, never as agreement', () => {
    // This decides whether somebody else's work gets approved.
    const out = readOpinions(two, [{ i: 0, ok: true }]);

    expect(out[1]).toMatchObject({ id: 20, verdict: 'unknown' });
  });

  it('drops an opinion it cannot read', () => {
    const out = readOpinions(two, [{ i: 0 }, { ok: true }, 'nonsense']);

    expect(out.every((judgement) => judgement.verdict === 'unknown')).toBe(true);
  });

  it('omits the model’s own wording when it matches the submission', () => {
    const out = readOpinions([two[0]!], [{ i: 0, ok: true, mine: 'Bir' }]);

    expect(out[0]).not.toHaveProperty('expected');
  });
});
