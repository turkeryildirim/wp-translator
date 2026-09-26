import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { agyItems, parseAgyResponse } from '../src/translate/agy.ts';

const reply = (extra: Record<string, unknown>): string =>
  JSON.stringify({ status: 'SUCCESS', ...extra });

describe('reading agy’s reply', () => {
  it('takes the translations from the schema-checked output', () => {
    // The point of this provider: the answer arrives already parsed, so nothing
    // has to be scraped out of prose or a fenced block.
    const out = parseAgyResponse(
      reply({ structured_output: { items: [{ i: 0, t: 'Kaydet' }, { i: 1, t: 'İptal' }] } }),
    );

    expect(out).toEqual([{ i: 0, t: 'Kaydet' }, { i: 1, t: 'İptal' }]);
  });

  it('carries a plural when the model gave one', () => {
    const out = parseAgyResponse(
      reply({ structured_output: { items: [{ i: 0, t: '%s ürün', tp: '%s ürün' }] } }),
    );

    expect(out[0]).toEqual({ i: 0, t: '%s ürün', tp: '%s ürün' });
  });

  it('drops an empty plural rather than storing one', () => {
    const out = parseAgyResponse(reply({ structured_output: { items: [{ i: 0, t: 'Sil', tp: '' }] } }));

    expect(out[0]).toEqual({ i: 0, t: 'Sil' });
  });

  it('fails when agy reports a failure, which it does with exit code zero', () => {
    expect(() =>
      parseAgyResponse(JSON.stringify({ status: 'ERROR', error: 'INVALID_ARGUMENT' })),
    ).toThrow(/ERROR.*INVALID_ARGUMENT/);
  });

  it('names the tool when the model spent its turn on a denied tool call', () => {
    // The real reply this asserts against: agy exits zero, reports SUCCESS with
    // an empty response and no structured output, and the only trace is
    // `denied_actions`. Reported as "ignored the schema" it sends you looking at
    // the payload instead of at the model reaching for a shell.
    const denied = readFileSync('test/fixtures/agy-denied-tool.json', 'utf-8');

    expect(() => agyItems(denied)).toThrow(/RunCommand/);
    expect(() => agyItems(denied)).toThrow(/tool call/);
  });

  it('fails when the model ignored the schema', () => {
    // Measured: a model can answer the schema with a summary of itself rather
    // than the data, and that must not read as an empty batch.
    expect(() => parseAgyResponse(reply({ structured_output: {} }))).toThrow(/no structured output/);
  });

  it('fails on an item missing its id or text', () => {
    expect(() =>
      parseAgyResponse(reply({ structured_output: { items: [{ t: 'Kaydet' }] } })),
    ).toThrow(/unusable item/);
  });

  it('fails loudly when the output is not JSON at all', () => {
    expect(() => parseAgyResponse('agy: command not found')).toThrow(/did not return JSON/);
  });
});
