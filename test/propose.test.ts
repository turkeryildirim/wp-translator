import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { proposeTranslations } from '../src/server/propose.ts';
import { sourceHash } from '../src/glossary/key.ts';
import { rememberTranslations } from '../src/ai/translationMemory.ts';
import { styleGuideFor } from '../src/server/tags.ts';
import type { ResponseItem, TranslationProvider, TranslationRequest } from '../src/translate/types.ts';

let db: Db;
let tagId: number;

/** A provider that answers from a table, and records what it was asked. */
const saying = (answers: Record<string, { t: string; tp?: string }>) => {
  const asked: string[] = [];
  const provider: TranslationProvider = {
    name: 'test',
    translate: (request: TranslationRequest): Promise<ResponseItem[]> => {
      for (const item of request.items) asked.push(item.s);
      return Promise.resolve(
        request.items.flatMap((item) => {
          const answer = answers[item.s];
          return answer ? [{ i: item.i, t: answer.t, ...(answer.tp ? { tp: answer.tp } : {}) }] : [];
        }),
      );
    },
  };
  return { provider, asked };
};

const refusing = (message: string): TranslationProvider => ({
  name: 'test',
  translate: () => Promise.reject(new Error(message)),
});

beforeEach(() => {
  db = openDb(':memory:');
  tagId = (db.prepare(`SELECT id FROM tags WHERE name = 'wordpress'`).get() as { id: number }).id;
});

const glossary = (source: string, translation: string, plural?: string): void => {
  db.prepare(
    `INSERT INTO glossary_entries
       (source_hash, source_text, source_plural, msgctxt, tag_id, translation, translation_plural, origin)
     VALUES (?, ?, ?, NULL, ?, ?, ?, 'trusted')`,
  ).run(sourceHash(source, undefined), source, null, tagId, translation, plural ?? null);
};

describe('proposing a translation for a string nobody has translated', () => {
  it('uses the glossary without asking, because a human approved it upstream', async () => {
    glossary('Save', 'Kaydet');
    const { provider, asked } = saying({});

    const result = await proposeTranslations(
      db,
      { items: [{ id: 1, source: 'Save' }] },
      { provider },
    );

    expect(result.proposals[0]).toMatchObject({ id: 1, translation: 'Kaydet', from: 'glossary' });
    expect(result.asked).toBe(0);
    expect(asked).toEqual([]);
  });

  it('will not use the glossary when it holds two wordings', async () => {
    // Picking one of two on the owner's behalf is the thing the glossary screen
    // exists to avoid; the model answers instead and the row says so.
    glossary('Item', 'Öge');
    glossary('Item', 'Ürün');
    const { provider } = saying({ Item: { t: 'Öge' } });

    const result = await proposeTranslations(db, { items: [{ id: 1, source: 'Item' }] }, { provider });

    expect(result.proposals[0]!.from).toBe('model');
  });

  it('serves a repeat from what the model already said', async () => {
    const styleGuide = styleGuideFor(db, 0);
    rememberTranslations(
      db,
      [{ i: 0, s: 'Delete' }],
      [{ i: 0, t: 'Sil' }],
      styleGuide,
      null,
    );
    const { provider, asked } = saying({});

    const result = await proposeTranslations(db, { items: [{ id: 9, source: 'Delete' }] }, { provider });

    expect(result.proposals[0]).toMatchObject({ id: 9, translation: 'Sil', from: 'memory' });
    expect(result.reused).toBe(1);
    expect(asked).toEqual([]);
  });

  it('puts the string’s own whitespace back on a remembered answer', async () => {
    // The store holds the words alone, so ` Save ` and `Save` share one entry and
    // each gets its own shape back. A trailing space is what the checks compare.
    rememberTranslations(db, [{ i: 0, s: 'Save' }], [{ i: 0, t: 'Kaydet' }], styleGuideFor(db, 0), null);
    const { provider } = saying({});

    const result = await proposeTranslations(db, { items: [{ id: 1, source: ' Save ' }] }, { provider });

    expect(result.proposals[0]!.translation).toBe(' Kaydet ');
  });

  it('offers nothing when the checks refuse the wording, and says which rule', async () => {
    // A proposal is applied to a live row on one click, so it passes the same
    // checks as anything else this tool writes.
    const { provider } = saying({ 'Use %1$s and %2$s': { t: 'Yalnızca %s kullan' } });

    const result = await proposeTranslations(
      db,
      { items: [{ id: 1, source: 'Use %1$s and %2$s' }] },
      { provider },
    );

    expect(result.proposals[0]).not.toHaveProperty('translation');
    expect(result.proposals[0]!.reason).toMatch(/placeholder/i);
  });

  it('takes both halves of a plural source', async () => {
    const { provider } = saying({ '%s item': { t: '%s öge', tp: '%s öge' } });

    const result = await proposeTranslations(
      db,
      { items: [{ id: 1, source: '%s item', sourcePlural: '%s items' }] },
      { provider },
    );

    expect(result.proposals[0]).toMatchObject({ translation: '%s öge', translationPlural: '%s öge' });
  });

  it('refuses a plural source answered with one form only', async () => {
    // Saving that would fill the singular and empty the plural.
    const { provider } = saying({ '%s item': { t: '%s öge' } });

    const result = await proposeTranslations(
      db,
      { items: [{ id: 1, source: '%s item', sourcePlural: '%s items' }] },
      { provider },
    );

    expect(result.proposals[0]).not.toHaveProperty('translation');
    expect(result.proposals[0]!.reason).toMatch(/plural/i);
  });

  it('keeps the batch when the provider cannot be reached', async () => {
    // One unreachable provider must not throw away the glossary's own answers, and
    // must never leave a row looking as though a wording was offered.
    glossary('Save', 'Kaydet');

    const result = await proposeTranslations(
      db,
      { items: [{ id: 1, source: 'Save' }, { id: 2, source: 'Cancel' }] },
      { provider: refusing('opencode did not answer within 240s') },
    );

    expect(result.proposals[0]).toMatchObject({ translation: 'Kaydet', from: 'glossary' });
    expect(result.proposals[1]).not.toHaveProperty('translation');
    expect(result.proposals[1]!.reason).toBeTruthy();
  });

  it('answers for every id it was given, in order', async () => {
    const { provider } = saying({ One: { t: 'Bir' } });

    const result = await proposeTranslations(
      db,
      { items: [{ id: 5, source: 'One' }, { id: 6, source: 'Two' }, { id: 7, source: 'Three' }] },
      { provider },
    );

    expect(result.proposals.map((p) => p.id)).toEqual([5, 6, 7]);
  });
});
