import { describe, expect, it } from 'vitest';
import { collectText, parseResponse, reconcile } from '../src/translate/opencode.ts';
import { buildPrompt } from '../src/translate/prompt.ts';
import type { TranslationRequest } from '../src/translate/types.ts';

const event = (type: string, text?: string) =>
  JSON.stringify({ type, sessionID: 'ses_1', part: text === undefined ? {} : { text } });

const request = (ids: number[]): TranslationRequest => ({
  items: ids.map((i) => ({ i, s: `string ${i}` })),
  context: { styleGuide: '', terms: [] },
});

describe('reading opencode output', () => {
  it('assembles the text parts of the event stream', () => {
    const stream = [event('step_start'), event('text', '[{"i":0,'), event('text', '"t":"A"}]')].join('\n');

    expect(collectText(stream)).toBe('[{"i":0,"t":"A"}]');
  });

  it('ignores lines that are not JSON', () => {
    expect(collectText(`not json\n${event('text', 'ok')}\n`)).toBe('ok');
  });

  it('returns nothing for an empty stream', () => {
    // What a hang looks like: zero bytes rather than an error (R21).
    expect(collectText('')).toBe('');
  });
});

describe('extracting the reply', () => {
  it('reads a bare JSON array', () => {
    expect(parseResponse('[{"i":0,"t":"Kaydet"}]')).toEqual([{ i: 0, t: 'Kaydet' }]);
  });

  it('reads an array inside a markdown fence', () => {
    expect(parseResponse('```json\n[{"i":0,"t":"Kaydet"}]\n```')).toEqual([{ i: 0, t: 'Kaydet' }]);
  });

  it('reads an array surrounded by prose', () => {
    expect(parseResponse('İşte çeviriler:\n[{"i":0,"t":"Kaydet"}]\nUmarım yardımcı olur.')).toEqual([
      { i: 0, t: 'Kaydet' },
    ]);
  });

  it('fails loudly when there is no array', () => {
    expect(() => parseResponse('Bunu çeviremem.')).toThrow(/did not return a JSON array/);
  });

  it('fails on a truncated array rather than salvaging part of it', () => {
    expect(() => parseResponse('[{"i":0,"t":"Kaydet"},{"i":1,"t":"Sil')).toThrow(
      /did not return a JSON array/,
    );
  });
});

describe('reconciling ids', () => {
  it('returns items in the order they were sent', () => {
    const result = reconcile(request([0, 1, 2]), [
      { i: 2, t: 'C' },
      { i: 0, t: 'A' },
      { i: 1, t: 'B' },
    ]);

    expect(result.map((r) => r.t)).toEqual(['A', 'B', 'C']);
  });

  it('fails when an id is missing, which is how truncation is caught', () => {
    expect(() => reconcile(request([0, 1, 2]), [{ i: 0, t: 'A' }])).toThrow(/missing 2 of 3 ids/);
  });

  it('fails when the model invents an id', () => {
    expect(() =>
      reconcile(request([0]), [
        { i: 0, t: 'A' },
        { i: 9, t: 'B' },
      ]),
    ).toThrow(/id 9, which was not sent/);
  });

  it('fails on a malformed element', () => {
    expect(() => reconcile(request([0]), [{ t: 'A' } as never])).toThrow(/Malformed element/);
  });

  it('never matches by position', () => {
    // A provider that reorders or merges must not be able to misalign silently.
    expect(() => reconcile(request([10, 20]), [{ i: 0, t: 'A' }, { i: 1, t: 'B' }])).toThrow(
      /was not sent/,
    );
  });
});

describe('the prompt', () => {
  it('lists every reading of a term, including part of speech and note', () => {
    const prompt = buildPrompt({
      styleGuide: '',
      terms: [
        {
          source: 'archive',
          readings: [
            { translation: 'arşiv', pos: 'noun' },
            { translation: 'arşivle', pos: 'verb', note: 'Eylem olarak' },
          ],
        },
      ],
    });

    expect(prompt).toContain('- archive = arşiv (noun) | arşivle (verb) — Eylem olarak');
  });

  it('leaves the glossary section out when there are no terms', () => {
    expect(buildPrompt({ styleGuide: '', terms: [] })).not.toContain('SÖZLÜK');
  });

  it('includes the style guide when there is one', () => {
    expect(buildPrompt({ styleGuide: 'Cümle düzeni kullan.', terms: [] })).toContain(
      'Cümle düzeni kullan.',
    );
  });

  it('tells the model to translate user-visible attribute text', () => {
    // The rule the checks enforce: structural attributes stay, title and its
    // kind are translated. Without it the prompt asks for untranslated tooltips.
    const prompt = buildPrompt({ styleGuide: '', terms: [] });

    expect(prompt).toContain('title, alt, aria-label, placeholder');
    expect(prompt).toContain('href');
    expect(prompt).toMatch(/Özniteliği silme/);
  });

  it('always states the output contract', () => {
    const prompt = buildPrompt({ styleGuide: '', terms: [] });

    expect(prompt).toContain('Yalnızca bir JSON dizisi döndür');
    expect(prompt).toContain('Yer tutucuları');
  });
});
