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
    fileURLToPath(new URL('../userscript/wp-translator-tier-run.user.js', import.meta.url)),
    'utf-8',
  );
  const module = { exports: {} as Record<string, (...args: never[]) => unknown> };
  new Function('module', 'document', source)(module, undefined);
  return module.exports;
}

interface Counts {
  all: number;
  translated: number;
  untranslated: number;
  changesRequested?: number;
  waiting?: number;
  fuzzy?: number;
}

const { projectionOf, tierOf, actOn, silenced, place, setKind, projectPath, chooseSets } =
  decisions() as unknown as {
    projectionOf: (counts: Counts) => { current: number; projected: number; gain: number };
    tierOf: (projected: number) => string;
    actOn: (judgement: { verdict: string; proposal?: string }) => string;
    silenced: (answer: {
      unreachable?: string;
      judgements?: { verdict: string; reason?: string }[];
    }) => string | null;
    place: (pathname: string) => string;
    setKind: (pathname: string) => string | null;
    projectPath: (pathname: string) => string;
    chooseSets: (pending: Record<string, number>) => string[];
  };

describe('where settling a queue would take a sub-project', () => {
  it('does not count a pending row whose string is already translated', () => {
    // elementor/dev, measured: the five status counts add up to 4,034 against an
    // `all` of 4,031, because three originals carry both a current translation
    // and a pending one. Approving those three moves the percentage by nothing,
    // so the gain is 34 and not the queue's 37.
    const elementor = {
      all: 4031,
      translated: 2295,
      untranslated: 1702,
      waiting: 6,
      fuzzy: 31,
      changesRequested: 0,
    };

    expect(projectionOf(elementor)).toEqual({ current: 57, projected: 58, gain: 34 });
  });

  it('agrees with a set whose counts do add up', () => {
    // connections/stable, measured: 536 + 1,174 + 2 = 1,712 = its own `All`.
    const connections = {
      all: 1712,
      translated: 536,
      untranslated: 1174,
      waiting: 0,
      fuzzy: 2,
      changesRequested: 0,
    };

    expect(projectionOf(connections)).toMatchObject({ projected: 32, gain: 2 });
  });

  it('counts nothing for a string sent back for changes', () => {
    // A rejected-with-feedback translation is not in the waiting queue, so this
    // run will never settle it and it must not be projected as settled.
    expect(projectionOf({ all: 100, translated: 50, untranslated: 20, changesRequested: 30 })).toMatchObject({
      projected: 50,
      gain: 0,
    });
  });

  it('is zero for a set with nothing in it, rather than a division', () => {
    // A set whose filter bar could not be read reports `all: 0`, and NaN would
    // sort into whichever band the comparison happens to fall through to.
    expect(projectionOf({ all: 0, translated: 0, untranslated: 0 })).toEqual({
      current: 0,
      projected: 0,
      gain: 0,
    });
  });

  it('reaches 100 only when nothing is left untranslated', () => {
    expect(projectionOf({ all: 403, translated: 2, untranslated: 401 })).toMatchObject({ projected: 1 });
    expect(projectionOf({ all: 403, translated: 2, untranslated: 0 })).toMatchObject({ projected: 100 });
  });
});

describe('which band a sub-project falls in', () => {
  it('leaves a set within reach of shipping to the owner', () => {
    expect(tierOf(90)).toBe('manual');
    expect(tierOf(75)).toBe('manual');
  });

  it('closes a set in the middle', () => {
    expect(tierOf(74)).toBe('auto');
    expect(tierOf(25)).toBe('auto');
  });

  it('rejects only what is out of reach', () => {
    // The edge belongs to the kinder side: a rejection is the one decision here
    // that cannot be taken back, so exactly 25 is worked rather than refused.
    expect(tierOf(24)).toBe('reject');
    expect(tierOf(0)).toBe('reject');
  });
});

describe('what a judgement does to a row', () => {
  it('approves the glossary’s own wording and the model’s agreement alike', () => {
    expect(actOn({ verdict: 'exact' })).toBe('approve');
    expect(actOn({ verdict: 'agreed' })).toBe('approve');
  });

  it('writes a flagged row’s proposal, and leaves one that has none', () => {
    // `proposal` is the server's wording after the quality checks accepted it.
    // Without one there is nothing safe to write, and the row is a person's.
    expect(actOn({ verdict: 'flagged', proposal: 'Ayarlar kaydedildi.' })).toBe('save');
    expect(actOn({ verdict: 'flagged' })).toBe('leave');
  });

  it('leaves a row nobody could decide', () => {
    expect(actOn({ verdict: 'unknown' })).toBe('leave');
  });

  it('stops on a provider the server could not reach at all', () => {
    // Measured against a dead opencode plan: the batch came back with one
    // `unknown` reading *Insufficient balance* beside a row the glossary had
    // already settled. Testing "every verdict is unknown" would have walked
    // thousands of rows past a provider that was gone, so the server says so.
    expect(
      silenced({
        unreachable: 'opencode: Insufficient balance or no resource package.',
        judgements: [{ verdict: 'unknown' }, { verdict: 'flagged' }],
      }),
    ).toMatch(/Insufficient balance/);
  });

  it('carries on past one row the model skipped', () => {
    expect(
      silenced({ judgements: [{ verdict: 'unknown' }, { verdict: 'agreed' }] }),
    ).toBeNull();
  });

  it('also stops when nothing in a batch was decided', () => {
    expect(
      silenced({ judgements: [{ verdict: 'unknown', reason: 'Karar verilemedi.' }] }),
    ).toBe('Karar verilemedi.');
    expect(silenced({ judgements: [] })).toBeNull();
  });
});

describe('finding the way around the site', () => {
  it('knows the three kinds of page the walk lives on', () => {
    expect(place('/locale/tr/default/wp-plugins/')).toBe('listing');
    expect(place('/locale/tr/default/wp-plugins/connections/')).toBe('plugin');
    expect(place('/projects/wp-plugins/connections/stable/tr/default/')).toBe('set');
    expect(place('/projects/wp-themes/phlox/tr/default/')).toBe('other');
  });

  it('names the project the way the server stores it', () => {
    expect(projectPath('/projects/wp-plugins/connections/stable/tr/default/')).toBe(
      'wp-plugins/connections/stable',
    );
  });

  it('reads only the four sub-projects a plugin has', () => {
    expect(setKind('/projects/wp-plugins/connections/dev-readme/tr/default/')).toBe('dev-readme');
    expect(setKind('/projects/wp-plugins/connections/branches/1.0/tr/default/')).toBeNull();
  });

  it('takes the set the pending rows are actually in', () => {
    // Measured on quiz-maker: dev and dev-readme were in step while stable held
    // 1,431 rows and stable-readme 183. Choosing development because it exists
    // walked past every pending row the plugin had.
    expect(
      chooseSets({ dev: 0, 'dev-readme': 0, stable: 1431, 'stable-readme': 183 }),
    ).toEqual(['stable', 'stable-readme']);
  });

  it('chooses each pair on its own', () => {
    // mycred: the work is in stable, and neither readme has any.
    expect(chooseSets({ dev: 83, stable: 1474, 'dev-readme': 0, 'stable-readme': 0 })).toEqual([
      'stable',
    ]);
    // peepso-core: the code work is in stable, the one readme row is on trunk.
    expect(chooseSets({ dev: 69, stable: 1511, 'dev-readme': 1, 'stable-readme': 0 })).toEqual([
      'stable',
      'dev-readme',
    ]);
  });

  it('gives a tie to trunk', () => {
    // loginizer: both readmes hold 299, which are the same submissions in two
    // sets — so either settles the same rows, and trunk is where a plugin's
    // current strings live.
    expect(chooseSets({ dev: 622, stable: 626, 'dev-readme': 299, 'stable-readme': 299 })).toEqual([
      'stable',
      'dev-readme',
    ]);
  });

  it('walks a sub-project that is the only one there is', () => {
    expect(chooseSets({ stable: 12, 'stable-readme': 3 })).toEqual(['stable', 'stable-readme']);
    expect(chooseSets({ dev: 12 })).toEqual(['dev']);
  });

  it('walks nothing for a plugin with nothing pending', () => {
    expect(chooseSets({ dev: 0, stable: 0, 'dev-readme': 0, 'stable-readme': 0 })).toEqual([]);
    expect(chooseSets({})).toEqual([]);
  });
});
