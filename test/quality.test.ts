import { describe, expect, it } from 'vitest';
import { checkTranslation, type CheckRule } from '../src/quality/check.ts';
import type { TranslationUnit } from '../src/po/types.ts';

const unit = (u: Partial<TranslationUnit>): TranslationUnit =>
  ({ ordinal: 0, msgid: '', ...u }) as TranslationUnit;

const rules = (u: Partial<TranslationUnit>): CheckRule[] =>
  checkTranslation(unit(u)).map((f) => f.rule);

describe('quality checks', () => {
  it('passes a clean translation', () => {
    expect(rules({ msgid: 'Add to cart', msgstr: 'Sepete ekle' })).toEqual([]);
  });

  it('finds nothing to say about a string with no technical structure', () => {
    // 51–92% of a project looks like this, and the checks are silent there by
    // design — review of those strings is semantic, not mechanical (R20).
    expect(rules({ msgid: 'Overlay position', msgstr: 'Yer paylaşımı konumu' })).toEqual([]);
  });

  it('catches a dropped placeholder', () => {
    const failures = checkTranslation(
      unit({ msgid: 'Showing %1$s of %2$s', msgstr: '%1$s gösteriliyor' }),
    );
    expect(failures.map((f) => f.rule)).toEqual(['printf-placeholders']);
    expect(failures[0]!.message).toContain('%2$s');
  });

  it('catches an invented placeholder', () => {
    expect(rules({ msgid: 'Could not install.', msgstr: '%s kurulamadı.' })).toEqual([
      'printf-placeholders',
    ]);
  });

  it('catches a placeholder used the wrong number of times', () => {
    const failures = checkTranslation(unit({ msgid: 'Copy %s', msgstr: '%s %s kopyala' }));
    expect(failures[0]!.message).toMatch(/1× in the source and 2× in the translation/);
  });

  it('accepts reordered positional placeholders', () => {
    // Turkish word order routinely moves these, which is the whole point of %1$s.
    expect(rules({ msgid: '%1$s in %2$s', msgstr: '%2$s içinde %1$s' })).toEqual([]);
  });

  it('accepts a literal %%', () => {
    expect(rules({ msgid: '50%% off', msgstr: '%%50 indirim' })).toEqual([]);
  });

  it('catches a lost HTML tag', () => {
    expect(
      rules({ msgid: 'Read the <a href="%s">docs</a>.', msgstr: 'Belgeleri okuyun.' }),
    ).toEqual(['printf-placeholders', 'html-tags']);
  });

  it('catches an altered href', () => {
    expect(
      rules({
        msgid: 'See <a href="https://example.com">this</a>.',
        msgstr: '<a href="https://other.example">şuna</a> bakın.',
      }),
    ).toEqual(['html-tags']);
  });

  it('catches an unclosed tag', () => {
    expect(rules({ msgid: '<strong>Warning</strong>', msgstr: '<strong>Uyarı' })).toEqual([
      'html-tags',
    ]);
  });

  it('catches a brace placeholder that went missing', () => {
    expect(rules({ msgid: '{count} items', msgstr: 'öge' })).toEqual(['brace-placeholders']);
  });

  it('catches a missing plural form', () => {
    expect(
      rules({ msgid: '%s item', msgidPlural: '%s items', msgstr: '%s öge' }),
    ).toEqual(['plural-missing']);
  });

  it('accepts a complete plural', () => {
    expect(
      rules({
        msgid: '%s item',
        msgidPlural: '%s items',
        msgstr: '%s öge',
        msgstrPlural: '%s öge',
      }),
    ).toEqual([]);
  });

  it('catches lost trailing whitespace', () => {
    // Matching is byte-exact, so a trimmed string stops matching next time (R13).
    expect(rules({ msgid: 'SKU: ', msgstr: 'Stok kodu:' })).toEqual(['trailing-whitespace']);
  });

  it('reports an empty translation once and stops', () => {
    expect(rules({ msgid: 'Showing %1$s of %2$s', msgstr: '' })).toEqual(['empty']);
  });
});
