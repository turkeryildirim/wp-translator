import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { rememberTranslations, splitByMemory } from '../src/ai/translationMemory.ts';
import { reconcile } from '../src/translate/opencode.ts';
import { checkTranslation } from '../src/quality/check.ts';
import { unescapeEchoedQuotes } from '../src/text/escapes.ts';
import type { RequestItem } from '../src/translate/types.ts';

/** The string this was reported on, and the answer that came back for it. */
const SOURCE =
  'Throw <code>TokenLimitReachedException</code> when the Anthropic API stops with' +
  ' <code>max_tokens</code> or <code>model_context_window_exceeded</code>, instead of silently' +
  ' returning a truncated result (<a href="https://github.com/WordPress/ai-provider-for-anthropic/pull/4">#4</a>).';

const ECHOED =
  'Anthropic API\'si <code>max_tokens</code> ya da <code>model_context_window_exceeded</code> ile' +
  ' durduğunda sessizce kesilmiş bir sonuç döndürmek yerine <code>TokenLimitReachedException</code>' +
  ' fırlat (<a href=\\"https://github.com/WordPress/ai-provider-for-anthropic/pull/4\\">#4</a>).';

const ask = (items: RequestItem[]) => ({ items, context: { styleGuide: '', terms: [] } });

describe('a quote the model echoed out of the payload', () => {
  it('is the reason the HTML check says the translation dropped the link', () => {
    // What the owner sees: the source's <a href="…"> against the answer's
    // <a href=\"…\">, reported as one tag missing and another invented.
    const failures = checkTranslation({ ordinal: 0, msgid: SOURCE, msgstr: ECHOED });

    expect(failures.map((failure) => failure.rule)).toEqual(['html-tags']);
  });

  it('is taken back off, so the same answer passes', () => {
    const [answer] = reconcile(ask([{ i: 0, s: SOURCE }]), [{ i: 0, t: ECHOED }]);

    expect(answer!.t).toContain('<a href="https://github.com/WordPress/ai-provider-for-anthropic/pull/4">');
    expect(checkTranslation({ ordinal: 0, msgid: SOURCE, msgstr: answer!.t })).toEqual([]);
  });

  it('is left alone where the source carries a backslash of its own', () => {
    // A real source from the same plugin. Here the model's backslashes are the
    // translation, and `\"` is a quote the source escaped itself.
    const source = 'Public <code>WordPress\\AI\\log_ai_request()</code> API, as the \\"log\\" of record.';
    const wording = 'Kayıt \\"günlüğü\\" olarak <code>WordPress\\AI\\log_ai_request()</code> API\'si.';

    expect(unescapeEchoedQuotes(source, wording)).toBe(wording);
  });

  it('is repaired on the plural against the plural source', () => {
    const [answer] = reconcile(
      ask([{ i: 0, s: '<b>%s</b> item', p: '<b>%s</b> items' }]),
      [{ i: 0, t: '<b title=\\"adet\\">%s</b> ürün', tp: '<b title=\\"adet\\">%s</b> ürün' }],
    );

    expect(answer!.t).toBe('<b title="adet">%s</b> ürün');
    expect(answer!.tp).toBe('<b title="adet">%s</b> ürün');
  });
});

describe('an echo already in the AI memory', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('is repaired when it is read, because memory is never asked again', () => {
    // The answer was stored before the repair existed. Nothing re-asks the model
    // for a string the store already holds, so a wording refused on the way out
    // would be refused for ever.
    rememberTranslations(db, [{ i: 0, s: SOURCE }], [{ i: 0, t: ECHOED }], '', 'gemini-3.8-flash-low');

    const { known } = splitByMemory(db, [{ i: 0, s: SOURCE }], '');

    expect(known.get(0)!.t).not.toContain('\\"');
    expect(checkTranslation({ ordinal: 0, msgid: SOURCE, msgstr: known.get(0)!.t })).toEqual([]);
  });
});
