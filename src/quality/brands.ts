import type { CheckFailure } from './check.ts';

export const DEFAULT_BRANDS: readonly string[] = [
  'WordPress',
  'WooCommerce',
  'Jetpack',
  'Gutenberg',
  'Akismet',
  'Elementor',
  'Yoast',
  'Google',
  'Google Analytics',
  'Facebook',
  'Instagram',
  'YouTube',
  'Twitter',
  'LinkedIn',
  'PayPal',
  'Stripe',
  'Mailchimp',
  'GitHub',
  'reCAPTCHA',
];

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Creates regex pattern that matches English ASCII i/I as well as Turkish İ/ı.
 */
function toTurkishPattern(brand: string): string {
  const escaped = escapeRegExp(brand);
  return escaped.replace(/[iI]/g, '[iİıI]');
}

interface CompiledBrandRules {
  brand: string;
  inSourcePattern: RegExp;
  apostrophePattern: RegExp;
  casingPattern: RegExp;
}

function compileBrand(brand: string): CompiledBrandRules {
  const brandPattern = toTurkishPattern(brand);
  return {
    brand,
    inSourcePattern: new RegExp(`(?<![\\p{L}\\p{N}])${brandPattern}(?![\\p{L}\\p{N}])`, 'iu'),
    apostrophePattern: new RegExp(
      `(?<![\\p{L}\\p{N}])(${brandPattern})([\\p{L}]+)(?![\\p{L}\\p{N}])`,
      'gui',
    ),
    casingPattern: new RegExp(
      `(?<![\\p{L}\\p{N}])(${brandPattern})(?![\\p{L}\\p{N}])`,
      'gui',
    ),
  };
}

const COMPILED_DEFAULT_BRANDS: readonly CompiledBrandRules[] = DEFAULT_BRANDS.map(compileBrand);
const BRAND_CACHE = new Map<string, CompiledBrandRules>();
for (const compiled of COMPILED_DEFAULT_BRANDS) {
  BRAND_CACHE.set(compiled.brand, compiled);
}

function getCompiledBrand(brand: string): CompiledBrandRules {
  let cached = BRAND_CACHE.get(brand);
  if (!cached) {
    cached = compileBrand(brand);
    BRAND_CACHE.set(brand, cached);
  }
  return cached;
}

/**
 * Remove HTML tags, URLs, email addresses, and domain names (e.g. wordpress.org)
 * so they don't produce false-positive brand casing or apostrophe violations.
 */
export function sanitizeForBrandCheck(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/[^\s<>"]+/gi, ' ')
    .replace(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/g, ' ')
    .replace(/(?<![\p{L}\p{N}])[a-zA-Z0-9-]+\.(?:[a-zA-Z]{2,})(?:\/[^\s<>"']*)?(?![\p{L}\p{N}])/giu, ' ');
}

export function checkBrandRules(
  source: string,
  translation: string,
  brands: readonly string[] = DEFAULT_BRANDS,
): CheckFailure[] {
  const failures: CheckFailure[] = [];
  const cleanTranslation = sanitizeForBrandCheck(translation);
  const seen = new Set<string>();

  const compiledList = brands === DEFAULT_BRANDS ? COMPILED_DEFAULT_BRANDS : brands.map(getCompiledBrand);

  for (const { brand, inSourcePattern, apostrophePattern, casingPattern } of compiledList) {
    // Check brand in the original source (before domain stripping, so "WordPress.org" still triggers check)
    if (!inSourcePattern.test(source)) {
      continue;
    }

    // 1. brand-apostrophe: Brand takes a suffix without an apostrophe (e.g. WordPressi, Instagramı)
    for (const match of cleanTranslation.matchAll(apostrophePattern)) {
      const found = match[0];
      const message = `Proper noun/brand takes a suffix without an apostrophe: "${found}" (use "${brand}'..." instead).`;
      if (!seen.has(message)) {
        seen.add(message);
        failures.push({
          rule: 'brand-apostrophe',
          message,
        });
      }
    }

    // 2. brand-casing: Brand casing mismatch (e.g. Wordpress, woocommerce, Github, recaptcha, İnstagram)
    for (const match of cleanTranslation.matchAll(casingPattern)) {
      const found = match[0];
      if (found !== brand) {
        const message = `Brand casing mismatch: "${found}" should be "${brand}".`;
        if (!seen.has(message)) {
          seen.add(message);
          failures.push({
            rule: 'brand-casing',
            message,
          });
        }
      }
    }
  }

  return failures;
}
