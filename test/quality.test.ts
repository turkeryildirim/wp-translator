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
    // Most of a project looks like this, and the checks are silent there by
    // design — review of those strings is semantic, not mechanical.
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

  it('understands the iOS object placeholder', () => {
    // The iOS catalogues are full of these; a pattern without %@ calls them clean.
    expect(rules({ msgid: 'Posted to %@', msgstr: 'Gönderildi' })).toEqual([
      'printf-placeholders',
    ]);
    expect(rules({ msgid: 'Posted to %@', msgstr: '%@ hedefine gönderildi' })).toEqual([]);
  });

  it('understands positional object placeholders and length modifiers', () => {
    expect(rules({ msgid: '%1$@ of %2$@', msgstr: '%2$@ içinde %1$@' })).toEqual([]);
    expect(rules({ msgid: '%ld items', msgstr: '%ld öge' })).toEqual([]);
    expect(rules({ msgid: '%1$ld of %2$d', msgstr: '%1$ld / %2$d' })).toEqual([]);
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

  it('accepts a translated title, because a tooltip is text the reader sees', () => {
    // Real WooCommerce string. Comparing title by value reported every properly
    // translated tooltip as damage.
    const source =
      'by <a href="%1$s" title="Sharing Docs">sharing</a> or ' +
      '<a href="%2$s" title="Transferring Docs">transferring</a>';
    const translation =
      '<a href="%1$s" title="Dokümanları Paylaşma">paylaşarak</a> veya ' +
      '<a href="%2$s" title="Dokümanları Aktarma">aktararak</a>';

    expect(rules({ msgid: source, msgstr: translation })).toEqual([]);
  });

  it('accepts a translated alt, aria-label and placeholder too', () => {
    expect(
      rules({
        msgid: '<img alt="A cat"><input aria-label="Search" placeholder="Type here">',
        msgstr: '<img alt="Bir kedi"><input aria-label="Ara" placeholder="Buraya yazın">',
      }),
    ).toEqual([]);
  });

  it('still catches a changed href, since a placeholder inside it must survive', () => {
    expect(
      rules({ msgid: '<a href="%1$s" title="A">x</a>', msgstr: '<a href="%2$s" title="B">y</a>' }),
    ).toContain('html-tags');
  });

  it('still catches a dropped title', () => {
    // Translating the tooltip is right; losing it is not.
    expect(
      rules({ msgid: '<a href="#" title="Help">x</a>', msgstr: '<a href="#">y</a>' }),
    ).toEqual(['html-tags']);
  });

  it('accepts reordered HTML, because Turkish word order moves it', () => {
    expect(rules({ msgid: '<b>A</b> and <i>B</i>', msgstr: '<i>B</i> ve <b>A</b>' })).toEqual([]);
  });

  it('accepts two links swapping places', () => {
    expect(
      rules({
        msgid: '<a href="%1$s">x</a> / <a href="%2$s">y</a>',
        msgstr: '<a href="%2$s">y</a> / <a href="%1$s">x</a>',
      }),
    ).toEqual([]);
  });

  it('still catches a duplicated tag, since that is a count and not an order', () => {
    expect(rules({ msgid: '<b>A</b>', msgstr: '<b>A</b> <b>B</b>' })).toEqual(['html-tags']);
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
    // Matching is byte-exact, so a trimmed string stops matching next time.
    expect(rules({ msgid: 'SKU: ', msgstr: 'Stok kodu:' })).toEqual(['trailing-whitespace']);
  });

  it('reports an empty translation once and stops', () => {
    expect(rules({ msgid: 'Showing %1$s of %2$s', msgstr: '' })).toEqual(['empty']);
  });
});
