import { describe, expect, it } from 'vitest';
import { collectText, parseResponse, reconcile, describeEvent } from '../src/translate/opencode.ts';
import { NO_TOOLS, buildPrompt } from '../src/translate/prompt.ts';
import { buildJudgePrompt } from '../src/judge/prompt.ts';
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
    // What a hang looks like: zero bytes rather than an error.
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

  it('forbids tool use, in both prompts', () => {
    // Measured against agy: without this line the model answers a batch by
    // trying to run a shell command, the request is denied, and the turn ends
    // with an empty response. Both providers are coding agents, so the rule
    // belongs to both prompts.
    expect(buildPrompt({ styleGuide: '', terms: [] })).toContain(NO_TOOLS);
    expect(buildJudgePrompt({ styleGuide: '', terms: [] })).toContain(NO_TOOLS);
    expect(NO_TOOLS).toMatch(/araç/);
  });

  it('does not tell the model the payload is an attached file', () => {
    // Only opencode attaches it; agy carries it inline, and describing a file
    // that is not there is an invitation to go and read one.
    expect(buildPrompt({ styleGuide: '', terms: [] })).not.toMatch(/Ekteki/);
  });

  it('tells the model it may reorder placeholders and tags', () => {
    expect(buildPrompt({ styleGuide: '', terms: [] })).toMatch(/SIRASI değişebilir/);
  });

  it('always states the output contract', () => {
    const prompt = buildPrompt({ styleGuide: '', terms: [] });

    expect(prompt).toContain('Yalnızca bir JSON dizisi döndür');
    expect(prompt).toContain('Yer tutucuları');
  });
});

describe('reading opencode’s event stream', () => {
  const line = (event: unknown): string | null => describeEvent(JSON.stringify(event));

  it('shows the text the model is producing', () => {
    // The only part of the stream worth watching: everything else is ids.
    expect(line({ type: 'text', part: { type: 'text', text: '[{"i":0,"t":"Kaydet"}' } })).toBe(
      '» [{"i":0,"t":"Kaydet"}',
    );
  });

  it('collapses whitespace so one answer stays one line', () => {
    expect(line({ type: 'text', part: { type: 'text', text: 'a\n\n  b' } })).toBe('» a b');
  });

  it('says when a request went out and when it came back', () => {
    expect(line({ type: 'step_start', part: { type: 'step-start' } })).toMatch(/gönderildi/);
    expect(line({ type: 'step_finish', part: { type: 'step-finish' } })).toMatch(/tamamladı/);
  });

  it('surfaces an error rather than swallowing it', () => {
    expect(line({ error: { name: 'ProviderAuthError' } })).toContain('ProviderAuthError');
  });

  it('says nothing about events with nothing to say', () => {
    expect(line({ type: 'snapshot', part: { id: 'prt_1', snapshot: 'abc' } })).toBeNull();
  });

  it('passes through anything that is not an event', () => {
    // opencode's own chatter, which is exactly what matters when it will not run.
    expect(describeEvent('opencode: command not found')).toBe('opencode: command not found');
  });
});
