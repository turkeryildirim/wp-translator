import { describe, expect, it } from 'vitest';
import { extractEdges, repairMechanically, repairTranslationUnit } from '../src/quality/repair.ts';

describe('repairMechanically', () => {
  it('restores missing trailing whitespace from source', () => {
    expect(repairMechanically('Save changes ', 'Değişiklikleri kaydet')).toBe('Değişiklikleri kaydet ');
    expect(repairMechanically('SKU: \t', 'Stok kodu:')).toBe('Stok kodu: \t');
  });

  it('restores missing leading whitespace from source', () => {
    expect(repairMechanically('  Indented text', 'Girintili metin')).toBe('  Girintili metin');
  });

  it('strips extraneous whitespace not present in source', () => {
    expect(repairMechanically('Save', 'Kaydet  ')).toBe('Kaydet');
    expect(repairMechanically('Cancel', '  İptal')).toBe('İptal');
  });

  it('preserves matching whitespace exactly and returns undefined for clean text', () => {
    expect(repairMechanically('Save changes', 'Değişiklikleri kaydet')).toBeUndefined();
    expect(repairMechanically('  Indent  ', '  Girinti  ')).toBeUndefined();
  });

  it('ignores empty or all-whitespace translations', () => {
    expect(repairMechanically('Save ', '   ')).toBeUndefined();
    expect(repairMechanically('Save ', '')).toBeUndefined();
  });

  it('removes echoed JSON quote escapes when source has plain quotes', () => {
    expect(
      repairMechanically('See <a href="%s">docs</a>', 'Bkz <a href=\\"%s\\">belgeler</a>'),
    ).toBe('Bkz <a href="%s">belgeler</a>');

    expect(
      repairMechanically('  say "hi" ', 'de \\"merhaba\\"'),
    ).toBe('  de "merhaba" ');
  });

  it('preserves literal backslashes when source carries them', () => {
    // If source intentionally carries a backslash, do not touch it
    expect(
      repairMechanically('Use "\\" character', 'Use "\\" karakteri'),
    ).toBeUndefined();
  });
});

describe('repairTranslationUnit', () => {
  it('repairs singular and plural forms together', () => {
    const result = repairTranslationUnit(
      '%d item ',
      '%d öge',
      '%d items ',
      '%d öge',
    );
    expect(result.repaired).toBe(true);
    expect(result.translation).toBe('%d öge ');
    expect(result.translationPlural).toBe('%d öge ');
  });

  it('flags repaired as false when both forms are clean', () => {
    const result = repairTranslationUnit(
      'Clean source',
      'Temiz çeviri',
    );
    expect(result.repaired).toBe(false);
    expect(result.translation).toBe('Temiz çeviri');
  });
});
