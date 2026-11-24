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
    expect(rules({ msgid: 'Select %s of %s', msgstr: '%2$s içinden %1$s ögesini seçin' })).toEqual([]);
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
    expect(
      rules({
        msgid: '<input type="submit" value="Save Changes"><optgroup label="Fruits">',
        msgstr: '<input type="submit" value="Değişiklikleri Kaydet"><optgroup label="Meyveler">',
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

  describe('suffix-on-placeholder', () => {
    it('catches printf placeholder with Turkish suffix', () => {
      expect(rules({ msgid: '%s settings', msgstr: "%s'in ayarları" })).toEqual([
        'suffix-on-placeholder',
      ]);
      expect(rules({ msgid: 'Sent to %1$s', msgstr: "%1$s'e gönderildi" })).toEqual([
        'suffix-on-placeholder',
      ]);
    });

    it('catches brace placeholder with Turkish suffix and curly apostrophe', () => {
      expect(rules({ msgid: 'Profile of {user}', msgstr: "{user}'ın profili" })).toEqual([
        'suffix-on-placeholder',
      ]);
      expect(rules({ msgid: 'Sent to {user}', msgstr: '{user}’e gönderildi' })).toEqual([
        'suffix-on-placeholder',
      ]);
      expect(rules({ msgid: 'Message from %(name)s', msgstr: "%(name)s'den mesaj" })).toEqual([
        'suffix-on-placeholder',
      ]);
    });

    it('accepts clean placeholders without apostrophe suffixes', () => {
      expect(rules({ msgid: '%s settings', msgstr: '%s ayarları' })).toEqual([]);
      expect(rules({ msgid: '%s user', msgstr: '%s adlı kullanıcı' })).toEqual([]);
      expect(rules({ msgid: "User '%s'", msgstr: "'%s' kullanıcısı" })).toEqual([]);
      expect(rules({ msgid: '50%% discount', msgstr: '%%50 indirim' })).toEqual([]);
    });
  });

  describe('number-plural-noun', () => {
    it('catches plural noun directly following %d or %u', () => {
      expect(rules({ msgid: '%d files', msgstr: '%d dosyalar' })).toEqual(['number-plural-noun']);
      expect(rules({ msgid: '%1$d files', msgstr: '%1$d dosyalar' })).toEqual([
        'number-plural-noun',
      ]);
      expect(rules({ msgid: '%u plugins', msgstr: '%u eklentiler' })).toEqual([
        'number-plural-noun',
      ]);
    });

    it('accepts singular noun directly following number placeholder', () => {
      expect(rules({ msgid: '%d files', msgstr: '%d dosya' })).toEqual([]);
      expect(rules({ msgid: '%1$d items', msgstr: '%1$d öge' })).toEqual([]);
      expect(rules({ msgid: '%u plugins', msgstr: '%u eklenti' })).toEqual([]);
    });

    it('preserves root words ending in -ler/-lar in the exception list even with case suffixes', () => {
      expect(rules({ msgid: '%d dollars', msgstr: '%d dolar' })).toEqual([]);
      expect(rules({ msgid: '%d dollars', msgstr: '%d dolara satıldı' })).toEqual([]);
      expect(rules({ msgid: '%d dollars', msgstr: '%d dolardan başlayan fiyatlar' })).toEqual([]);
      expect(rules({ msgid: '%d dollars', msgstr: '%d doları aştı' })).toEqual([]);
      expect(rules({ msgid: '%d popular items', msgstr: '%d popüler öge' })).toEqual([]);
      expect(rules({ msgid: '%d cellars', msgstr: '%d kiler' })).toEqual([]);
      expect(rules({ msgid: '%d alarms', msgstr: '%d çalar saat' })).toEqual([]);
      expect(rules({ msgid: '%d modular units', msgstr: '%d modüler bileşen' })).toEqual([]);
      expect(rules({ msgid: '%d controllers', msgstr: '%d controller bulundu' })).toEqual([]);
      expect(rules({ msgid: '%d handlers', msgstr: '%d handler kaydedildi' })).toEqual([]);
    });
  });

  describe('brand rules', () => {
    it('catches brand casing mismatches', () => {
      const failuresWp = checkTranslation(
        unit({ msgid: 'Install WordPress now', msgstr: 'Wordpress kurun' }),
      );
      expect(failuresWp.map((f) => f.rule)).toEqual(['brand-casing']);
      expect(failuresWp[0]!.message).toBe('Brand casing mismatch: "Wordpress" should be "WordPress".');

      expect(rules({ msgid: 'WooCommerce Store', msgstr: 'woocommerce mağazası' })).toEqual([
        'brand-casing',
      ]);
      expect(rules({ msgid: 'GitHub repository', msgstr: 'Github deposu' })).toEqual([
        'brand-casing',
      ]);
      expect(rules({ msgid: 'reCAPTCHA protection', msgstr: 'recaptcha koruması' })).toEqual([
        'brand-casing',
      ]);
      expect(rules({ msgid: 'Follow on Instagram', msgstr: 'İnstagram hesabımızı takip edin' })).toEqual([
        'brand-casing',
      ]);
      expect(
        rules({
          msgid: 'Get plugins on WordPress.org',
          msgstr: 'Eklentileri Wordpress üzerinden edinin',
        }),
      ).toEqual(['brand-casing']);
    });

    it('catches brand suffixes without apostrophe', () => {
      const failures = checkTranslation(
        unit({ msgid: 'Install WordPress', msgstr: 'WordPressi kurun' }),
      );
      expect(failures.map((f) => f.rule)).toEqual(['brand-apostrophe']);
      expect(failures[0]!.message).toBe(
        'Proper noun/brand takes a suffix without an apostrophe: "WordPressi" (use "WordPress\'..." instead).',
      );

      const failuresIg = checkTranslation(
        unit({ msgid: 'Follow on Instagram', msgstr: 'Instagramı takip edin' }),
      );
      expect(failuresIg.map((f) => f.rule)).toEqual(['brand-apostrophe']);
      expect(failuresIg[0]!.message).toBe(
        'Proper noun/brand takes a suffix without an apostrophe: "Instagramı" (use "Instagram\'..." instead).',
      );
    });

    it('accepts correct brand casing and proper apostrophe suffixes', () => {
      expect(
        rules({ msgid: 'Install WordPress', msgstr: "WordPress'i kurun" }),
      ).toEqual([]);
      expect(
        rules({ msgid: 'Install WordPress', msgstr: 'WordPress’i kurun' }),
      ).toEqual([]);
      expect(
        rules({ msgid: 'Powered by WooCommerce and Jetpack', msgstr: 'WooCommerce ve Jetpack ile güçlendirilmiştir' }),
      ).toEqual([]);
    });

    it('sanitizes HTML tags, URLs, emails, and domains to prevent false positives', () => {
      // Domain wordpress.org should not trigger brand casing
      expect(
        rules({
          msgid: 'Visit wordpress.org for downloads',
          msgstr: 'İndirmeler için wordpress.org adresini ziyaret edin',
        }),
      ).toEqual([]);

      // URL in href should not trigger brand casing
      expect(
        rules({
          msgid: 'See <a href="https://wordpress.org">docs</a>.',
          msgstr: '<a href="https://wordpress.org">Belgeleri</a> inceleyin.',
        }),
      ).toEqual([]);

      // Email address should not trigger brand casing
      expect(
        rules({
          msgid: 'Contact support@woocommerce.com',
          msgstr: 'support@woocommerce.com adresine yazın',
        }),
      ).toEqual([]);
    });

    it('deduplicates failure messages across singular and plural forms', () => {
      const failures = checkTranslation(
        unit({
          msgid: 'Install %s',
          msgidPlural: 'Install %s',
          msgstr: "%s'in ayarları",
          msgstrPlural: "%s'in ayarları",
        }),
      );
      // Both singular and plural violate suffix-on-placeholder, but only 1 failure should be emitted
      expect(failures.length).toBe(1);
      expect(failures[0]!.rule).toBe('suffix-on-placeholder');
    });
  });
});
