import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The userscript's decisions, loaded without a page.
 *
 * It is a userscript, so it cannot be imported: it is evaluated with `document`
 * absent, which is what keeps it from starting a run, and hands its decisions
 * back through `module.exports`.
 */
function decisions(): Record<string, (...args: never[]) => unknown> {
  const source = readFileSync(
    fileURLToPath(new URL('../userscript/wp-translator-tm-approve.user.js', import.meta.url)),
    'utf-8',
  );
  const module = { exports: {} as Record<string, (...args: never[]) => unknown> };
  new Function('module', 'document', source)(module, undefined);
  return module.exports;
}

const {
  place,
  setKind,
  chooseSets,
  noCodeProject,
  carries,
  complaint,
  countOf,
  parseScore,
  hundredPercent,
  isExactMatch,
} = decisions() as {
    place: (pathname: string) => string;
    setKind: (pathname: string) => string | null;
    chooseSets: (kinds: string[]) => string[];
    noCodeProject: (kinds: string[]) => boolean;
    carries: (body: string, field: string, id: number | string) => boolean;
    complaint: (text: string) => string | null;
    countOf: (text: string | null) => number;
    parseScore: (text: string | null) => number | null;
    hundredPercent: (suggestions: { score: number | null; text: string }[]) => string[];
    isExactMatch: (wordings: string[], translation: string) => boolean;
  };

describe('what the memory is allowed to settle', () => {
  it('keeps only the suggestions scored 100%', () => {
    // The score is the similarity of the *source* string. A 95% suggestion is a
    // translation of a different English string, so its wording matching this
    // row's is a coincidence, not an endorsement.
    const offered = [
      { score: 100, text: 'Geri al' },
      { score: 95, text: 'Sil' },
      { score: null, text: 'Kaldır' },
    ];

    expect(hundredPercent(offered)).toEqual(['Geri al']);
  });

  it('does not fold case or edge whitespace', () => {
    // The memory holds "Geri yükle", "Geri Yükle" and "Geri Yükleme" as separate
    // entries for one string; treating them as one approves a wording nobody
    // offered for this row, and a trailing space is a difference GlotPress's own
    // checks are watching.
    const wordings = ['Geri yükle', 'Geri Yükle'];

    expect(isExactMatch(wordings, 'Geri yükle')).toBe(true);
    expect(isExactMatch(wordings, 'geri yükle')).toBe(false);
    expect(isExactMatch(wordings, 'Geri yükle ')).toBe(false);
    expect(isExactMatch([], 'Geri yükle')).toBe(false);
  });

  it('keeps the memory\u2019s own order, so the first wording is the first 100% one', () => {
    // The wording that replaces a submission is the first of these, and GlotPress
    // puts its own best first. Filtering has to keep that order and skip the
    // lower scores rather than hand back the first suggestion of any score.
    const offered = [
      { score: 95, text: 'Özel:' },
      { score: 100, text: 'Özel' },
      { score: 100, text: 'Özel alan' },
    ];

    expect(hundredPercent(offered)).toEqual(['Özel', 'Özel alan']);
    expect(hundredPercent(offered)[0]).toBe('Özel');
  });

  it('reads a score out of the badge and a count out of a thousands separator', () => {
    expect(parseScore('100%')).toBe(100);
    expect(parseScore('95%')).toBe(95);
    expect(parseScore('')).toBeNull();
    expect(countOf('3,228')).toBe(3228);
    expect(countOf('0')).toBe(0);
  });
});

describe('reading the page\u2019s own answer', () => {
  it('matches the id a write names, not one that merely starts with it', () => {
    // The walk reads the refusal out of the request GlotPress made for *this* row.
    // A loose match picks up the neighbouring row's answer, which is how a refused
    // write gets reported against a row that was never touched.
    const body = 'translation_id=96904045&status=current&_gp_route_nonce=abc';

    expect(carries(body, 'translation_id', 96904045)).toBe(true);
    expect(carries(body, 'translation_id', 9690404)).toBe(false);
    expect(carries(body, 'translation_id', 969040450)).toBe(false);
    expect(carries('original_id=2442160', 'original_id', 2442160)).toBe(true);
  });

  it('calls a 200 a refusal only where the answer says so itself', () => {
    // What a 200 means is GlotPress's business. Reading success out of one would
    // report a write that never happened; reading a refusal out of its own
    // `success: false` is the page saying it plainly.
    expect(complaint('{"success":false,"data":"Nonce is invalid"}')).toBe('Nonce is invalid');
    expect(complaint('{"success":false}')).toBe('istek reddedildi');
    expect(complaint('{"error":"forbidden"}')).toBe('forbidden');
    expect(complaint('{"success":true,"data":"<ul>…</ul>"}')).toBeNull();
    expect(complaint('<tr class="preview status-current">')).toBeNull();
  });
});

describe('where the walk goes', () => {
  it('works development where there is one, and stable only where there is not', () => {
    // A plugin with a development project has its current strings there; falling
    // back to stable as well would approve the same string twice, and never
    // falling back would walk past a plugin that only has stable.
    expect(chooseSets(['stable', 'stable-readme', 'dev', 'dev-readme'])).toEqual([
      'dev',
      'dev-readme',
    ]);
    expect(chooseSets(['stable', 'stable-readme'])).toEqual(['stable', 'stable-readme']);
    expect(chooseSets(['dev'])).toEqual(['dev']);
    expect(chooseSets([])).toEqual([]);
  });

  it('tells the three pages of the walk apart', () => {
    // The walk resumes from whatever page loaded, so a path it reads wrongly is a
    // step repeated or skipped for ever.
    expect(place('/locale/tr/default/wp-plugins/')).toBe('listing');
    expect(place('/locale/tr/default/wp-plugins/fluent-community/')).toBe('plugin');
    expect(place('/projects/wp-plugins/fluent-community/dev/tr/default/')).toBe('set');
    expect(place('/projects/wp-plugins/fluent-community/dev/fr/default/')).toBe('other');
  });

  it('calls a plugin unlocalisable only when it has neither code project', () => {
    // `locale-project.php` renders the notice on exactly this condition, and the
    // walk rejects every pending row of such a plugin — so a table it could not
    // read must not look like one.
    expect(noCodeProject(['dev-readme'])).toBe(true);
    expect(noCodeProject(['dev-readme', 'stable-readme'])).toBe(true);
    expect(noCodeProject(['stable', 'stable-readme'])).toBe(false);
    expect(noCodeProject(['dev', 'dev-readme'])).toBe(false);
    expect(noCodeProject([])).toBe(false);
  });

  it('names only the four sub-projects it walks', () => {
    expect(setKind('/projects/wp-plugins/directorist/dev/tr/default/')).toBe('dev');
    expect(setKind('/projects/wp-plugins/directorist/dev-readme/tr/default/')).toBe('dev-readme');
    expect(setKind('/projects/wp-plugins/directorist/stable-readme/tr/default/')).toBe(
      'stable-readme',
    );
    expect(setKind('/projects/wp-plugins/directorist/1-0-x/tr/default/')).toBeNull();
  });
});
