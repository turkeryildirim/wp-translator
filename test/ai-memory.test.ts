import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { affixes, clearMemory, deleteMemoryEntries, deleteMemoryEntry, listMemoryEntries, memoryCounts, reapply, questionKey } from '../src/ai/memory.ts';
import { rememberTranslations, reshape, splitByMemory } from '../src/ai/translationMemory.ts';

let db: Db;
const GUIDE = 'kurallar';

beforeEach(() => {
  db = openDb(':memory:');
});

describe('factoring a string’s shape out of its meaning', () => {
  it('treats the same words in different wrapping as one question', () => {
    // A leading or trailing space is a difference of shape, not of meaning, and
    // keeping them apart would fill the store with near duplicates.
    expect(questionKey(['Save'])).toBe(questionKey(['  Save \n']));
  });

  it('keeps anything that changes what the string says', () => {
    expect(questionKey(['Save'])).not.toBe(questionKey(['Save changes']));
    expect(questionKey(['Save'])).not.toBe(questionKey(['‎Save']));
  });

  it('puts the shape back from the string being answered', () => {
    expect(reapply('Kaydet', affixes('  Save \n'))).toBe('  Kaydet \n');
  });

  it('leaves a whitespace-only string alone', () => {
    expect(affixes('   ')).toEqual({ lead: '', core: '', trail: '   ' });
  });
});

describe('asking without the shape', () => {
  it('strips the whitespace before the model sees it', () => {
    // The model is asked what the words mean, not what shape they came in.
    const { ask } = splitByMemory(db, [{ i: 0, s: '  Save ', p: ' %s items ' }], GUIDE);

    expect(ask[0]).toEqual({ i: 0, s: 'Save', p: '%s items' });
  });

  it('puts each source’s own shape back on its answer', () => {
    const shaped = reshape(
      [{ i: 0, s: '  Save ' }, { i: 1, s: 'Delete' }],
      [{ i: 0, t: 'Kaydet' }, { i: 1, t: 'Sil' }],
    );

    expect(shaped).toEqual([{ i: 0, t: '  Kaydet ' }, { i: 1, t: 'Sil' }]);
  });

  it('reshapes a plural against the plural source, not the singular', () => {
    const shaped = reshape(
      [{ i: 0, s: 'item', p: ' items ' }],
      [{ i: 0, t: 'ürün', tp: 'ürünler' }],
    );

    expect(shaped[0]).toEqual({ i: 0, t: 'ürün', tp: ' ürünler ' });
  });
});

describe('translation memory', () => {
  it('answers the second project from the first', () => {
    rememberTranslations(db, [{ i: 0, s: 'Theme Description' }], [{ i: 0, t: 'Tema açıklaması' }], GUIDE, 'agy');

    const { known, ask } = splitByMemory(db, [{ i: 7, s: 'Theme Description' }], GUIDE);

    expect(ask).toEqual([]);
    expect(known.get(7)).toEqual({ i: 7, t: 'Tema açıklaması' });
  });

  it('reshapes the stored answer to the string that asked', () => {
    rememberTranslations(db, [{ i: 0, s: 'Save' }], [{ i: 0, t: 'Kaydet' }], GUIDE, 'agy');

    const { known } = splitByMemory(db, [{ i: 1, s: '  Save ' }], GUIDE);

    expect(known.get(1)?.t).toBe('  Kaydet ');
  });

  it('forgets answers when the rules change', () => {
    // An opinion formed under one style guide is not evidence under another.
    rememberTranslations(db, [{ i: 0, s: 'Save' }], [{ i: 0, t: 'Kaydet' }], GUIDE, 'agy');

    expect(splitByMemory(db, [{ i: 0, s: 'Save' }], 'başka kurallar').ask).toHaveLength(1);
  });

  it('carries a plural, each half reshaped on its own', () => {
    rememberTranslations(
      db,
      [{ i: 0, s: '%s item ', p: ' %s items' }],
      [{ i: 0, t: '%s ürün ', tp: ' %s ürün' }],
      GUIDE,
      'agy',
    );

    const { known } = splitByMemory(db, [{ i: 0, s: '%s item', p: '%s items' }], GUIDE);
    expect(known.get(0)).toEqual({ i: 0, t: '%s ürün', tp: '%s ürün' });
  });

  it('stores nothing for an empty translation', () => {
    rememberTranslations(db, [{ i: 0, s: 'Save' }], [{ i: 0, t: '   ' }], GUIDE, 'agy');

    expect(memoryCounts(db).translation).toBe(0);
  });

  it('counts how often it saved a question', () => {
    rememberTranslations(db, [{ i: 0, s: 'Save' }], [{ i: 0, t: 'Kaydet' }], GUIDE, 'agy');
    splitByMemory(db, [{ i: 0, s: 'Save' }], GUIDE);
    splitByMemory(db, [{ i: 0, s: 'Save' }], GUIDE);

    expect(memoryCounts(db)).toMatchObject({ translation: 1, reuses: 2 });
  });

  it('deletes single entries, multiple entries, and clears memory by kind', () => {
    rememberTranslations(db, [{ i: 0, s: 'One' }], [{ i: 0, t: 'Bir' }], GUIDE, 'agy');
    rememberTranslations(db, [{ i: 1, s: 'Two' }], [{ i: 1, t: 'İki' }], GUIDE, 'agy');
    rememberTranslations(db, [{ i: 2, s: 'Three' }], [{ i: 2, t: 'Üç' }], GUIDE, 'agy');

    const listed = listMemoryEntries(db, { kind: 'translation' });
    expect(listed.total).toBe(3);

    const firstId = listed.entries[0]!.id;
    const deletedSingle = deleteMemoryEntry(db, firstId);
    expect(deletedSingle).toBe(true);

    const secondId = listed.entries[1]!.id;
    const deletedMultiple = deleteMemoryEntries(db, [secondId]);
    expect(deletedMultiple).toBe(1);

    expect(deleteMemoryEntries(db, [])).toBe(0);

    const cleared = clearMemory(db, 'translation');
    expect(cleared).toBe(1);
    expect(listMemoryEntries(db).total).toBe(0);
  });
});
