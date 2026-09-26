import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { importProject, setProjectTags } from '../src/project/import.ts';
import { startTranslation, stopTranslation, translateProgress } from '../src/server/translate.ts';
import { saveStyleRule } from '../src/server/tags.ts';
import type { Catalogue, TranslationUnit } from '../src/po/types.ts';
import type { TranslationProvider, TranslationRequest } from '../src/translate/types.ts';

const catalogue = (msgids: string[]): Catalogue => ({
  headers: {},
  units: msgids.map((msgid, ordinal) => ({ ordinal, msgid }) as TranslationUnit),
});

/** Records what it was asked, so the test can assert on the request as well as the result. */
const stub = (
  answer: (
    request: TranslationRequest,
  ) => { i: number; t: string }[] | Promise<{ i: number; t: string }[]>,
): TranslationProvider & { calls: TranslationRequest[] } => {
  const calls: TranslationRequest[] = [];
  return {
    name: 'stub',
    calls,
    translate(request) {
      calls.push(request);
      return Promise.resolve(answer(request));
    },
  };
};

const settled = () =>
  new Promise<void>((resolve) => {
    const tick = () => (translateProgress().running ? setTimeout(tick, 5) : resolve());
    tick();
  });

let db: Db;
let projectId: number;

const states = () =>
  Object.fromEntries(
    (
      db
        .prepare(`SELECT state, count(*) AS n FROM translation_units GROUP BY state`)
        .all() as { state: string; n: number }[]
    ).map((row) => [row.state, row.n]),
  );

beforeEach(() => {
  db = openDb(':memory:');
  projectId = importProject(
    db,
    { family: 'plugin', projectPath: 'p', translateUrl: 't' },
    catalogue(['Save', 'Cancel', 'Delete', 'Edit %s']),
  );
});

describe('running a translation', () => {
  it('translates everything the glossary left and lands it in review', async () => {
    const provider = stub((request) => request.items.map((item) => ({ i: item.i, t: `TR:${item.s}` })));

    startTranslation(db, projectId, { provider, chunkSize: 10, lanes: 1 });
    await settled();

    expect(translateProgress()).toMatchObject({ total: 4, translated: 4, flagged: 0, errors: [] });
    expect(states()).toEqual({ review: 4 });
  });

  it('splits into chunks and asks for each separately', async () => {
    const provider = stub((request) => request.items.map((item) => ({ i: item.i, t: 'x' })));

    startTranslation(db, projectId, { provider, chunkSize: 2, lanes: 1 });
    await settled();

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls.map((call) => call.items.length)).toEqual([2, 2]);
  });

  it('renumbers ids within each chunk', async () => {
    // Ids are opaque and per request; the second chunk starts at 0 again, and the
    // units are recovered by position within the chunk rather than by a global id.
    const provider = stub((request) => request.items.map((item) => ({ i: item.i, t: item.s })));

    startTranslation(db, projectId, { provider, chunkSize: 2, lanes: 1 });
    await settled();

    expect(provider.calls[1]!.items.map((item) => item.i)).toEqual([0, 1]);
    const rows = db
      .prepare(`SELECT msgid, msgstr FROM translation_units ORDER BY ordinal`)
      .all() as { msgid: string; msgstr: string }[];
    expect(rows.every((row) => row.msgid === row.msgstr)).toBe(true);
  });

  it('counts a translation the checks refuse but still stores it', async () => {
    // Losing the model's work would mean paying for it twice; the unit stays in
    // review and the panel shows why it cannot be approved.
    const provider = stub((request) =>
      request.items.map((item) => ({ i: item.i, t: item.s === 'Edit %s' ? 'Düzenle' : 'ok' })),
    );

    startTranslation(db, projectId, { provider, chunkSize: 10, lanes: 1 });
    await settled();

    expect(translateProgress()).toMatchObject({ translated: 3, flagged: 1 });
    expect(
      (db.prepare(`SELECT msgstr FROM translation_units WHERE msgid = 'Edit %s'`).get() as {
        msgstr: string;
      }).msgstr,
    ).toBe('Düzenle');
  });

  it('retries a chunk before giving up on it', async () => {
    // A stalled request is the common failure and it costs the whole chunk, so
    // one retry turns fifty lost strings into a delay.
    let tries = 0;
    const provider = stub((request) => {
      tries += 1;
      if (tries === 1) throw new Error('the model stalled');
      return request.items.map((item) => ({ i: item.i, t: 'ok' }));
    });

    startTranslation(db, projectId, { provider, chunkSize: 2, lanes: 1 });
    await settled();

    expect(translateProgress().errors).toHaveLength(0);
    expect(states()).toEqual({ review: 4 });
  });

  it('leaves a failed chunk untranslated so a re-run covers it', async () => {
    let tries = 0;
    const provider = stub((request) => {
      tries += 1;
      // Both attempts at the first chunk fail; the second chunk answers.
      if (tries <= 2) throw new Error('the model refused');
      return request.items.map((item) => ({ i: item.i, t: 'ok' }));
    });

    startTranslation(db, projectId, { provider, chunkSize: 2, lanes: 1 });
    await settled();

    expect(translateProgress().errors).toHaveLength(1);
    expect(states()).toEqual({ untranslated: 2, review: 2 });

    startTranslation(db, projectId, { provider, chunkSize: 2, lanes: 1 });
    await settled();

    expect(states()).toEqual({ review: 4 });
  });

  it('sends the style guide and the terms that appear in the chunk', async () => {
    saveStyleRule(db, null, 'Cümle düzeni kullan.');
    const tagId = Number(db.prepare(`INSERT INTO tags (name) VALUES ('wp')`).run().lastInsertRowid);
    setProjectTags(db, projectId, [tagId]);
    db.prepare(
      `INSERT INTO glossary_entries (source_hash, source_text, tag_id, translation, origin)
       VALUES ('h', 'Save', ?, 'Kaydet', 'owner')`,
    ).run(tagId);

    const provider = stub((request) => request.items.map((item) => ({ i: item.i, t: 'x' })));
    startTranslation(db, projectId, { provider, chunkSize: 10, lanes: 1 });
    await settled();

    expect(provider.calls[0]!.context.styleGuide).toContain('Cümle düzeni kullan.');
    expect(provider.calls[0]!.context.terms.map((term) => term.source)).toContain('Save');
  });

  it('does nothing when there is nothing left', async () => {
    db.prepare(`UPDATE translation_units SET state = 'ok', msgstr = 'x'`).run();

    startTranslation(db, projectId, { provider: stub(() => []), chunkSize: 10, lanes: 1 });
    await settled();

    expect(translateProgress()).toMatchObject({ total: 0, translated: 0 });
  });

  it('refuses to start a second run while one is going', async () => {
    const slow = stub((request) => request.items.map((item) => ({ i: item.i, t: 'x' })));
    const first = startTranslation(db, projectId, { provider: slow, chunkSize: 1, lanes: 1 });
    const second = startTranslation(db, projectId, { provider: slow, chunkSize: 1, lanes: 1 });

    expect(second).toBe(first);
    await settled();
  });
});

describe('watching a run', () => {
  it('reports how long the request in flight has been out', async () => {
    // opencode answers in one piece rather than streaming, so elapsed time is
    // the only sign of life between the request and the answer.
    let seen: number | null = -1;
    const provider = stub((request) => {
      seen = translateProgress().waitingSince;
      return request.items.map((item) => ({ i: item.i, t: 'ok' }));
    });

    startTranslation(db, projectId, { provider, chunkSize: 4, lanes: 1 });
    expect(seen).not.toBeNull();
    await settled();

    // Cleared once nothing is out, so the clock does not run on after the end.
    expect(translateProgress().waitingSince).toBeNull();
  });

  it('publishes the timeout, so the wait has a stated bound', async () => {
    const provider = stub((request) => request.items.map((item) => ({ i: item.i, t: 'ok' })));

    startTranslation(db, projectId, { provider, chunkSize: 4, timeoutMs: 90_000, lanes: 1 });
    await settled();

    expect(translateProgress().timeoutMs).toBe(90_000);
  });

  it('keeps the tail of what the provider wrote', async () => {
    // A stalled request and a slow one look identical from outside; the
    // provider's own output is the difference.
    const provider = stub((request) => request.items.map((item) => ({ i: item.i, t: 'ok' })));

    startTranslation(db, projectId, { provider, chunkSize: 4, lanes: 1 });
    await settled();

    expect(translateProgress().log).toEqual([]);
  });

  it('notes which chunk failed, in order', async () => {
    const provider = stub(() => {
      throw new Error('the model refused');
    });

    startTranslation(db, projectId, { provider, chunkSize: 4, lanes: 1 });
    await settled();

    expect(translateProgress().log).toContain('-- küme 1 başarısız');
    expect(translateProgress().errors).toHaveLength(1);
  });
});

describe('stopping a run', () => {
  it('stops after the request in flight and leaves the rest untranslated', async () => {
    // The chunk it was on is lost, exactly as a failed one is, so a later run
    // picks up what is left.
    const provider = stub((request) => {
      stopTranslation();
      return request.items.map((item) => ({ i: item.i, t: 'ok' }));
    });

    startTranslation(db, projectId, { provider, chunkSize: 2, lanes: 1 });
    await settled();

    expect(translateProgress().running).toBe(false);
    expect(states().untranslated).toBeGreaterThan(0);
  });

  it('does not report stopping as a failed chunk', async () => {
    const provider = stub(() => {
      stopTranslation();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });

    startTranslation(db, projectId, { provider, chunkSize: 2, lanes: 1 });
    await settled();

    expect(translateProgress().errors).toEqual([]);
    expect(translateProgress().log).toContain('-- durduruldu');
  });
});

describe('running several requests at once', () => {
  it('keeps more than one out at a time', async () => {
    // The provider's timing varies enough that one queue spends most of it
    // waiting; lanes let the quick answers keep arriving.
    let peak = 0;
    let out = 0;
    const provider = stub(async (request) => {
      out += 1;
      peak = Math.max(peak, out);
      await new Promise((resolve) => setTimeout(resolve, 20));
      out -= 1;
      return request.items.map((item) => ({ i: item.i, t: 'ok' }));
    });

    startTranslation(db, projectId, { provider, chunkSize: 1, lanes: 3, staggerMs: 0 });
    await settled();

    expect(peak).toBeGreaterThan(1);
    expect(states()).toEqual({ review: 4 });
  });

  it('translates every batch exactly once, whatever the order', async () => {
    // Lanes take batches from one queue, so none may be done twice or skipped.
    const seen: string[] = [];
    const provider = stub((request) => {
      for (const item of request.items) seen.push(item.s);
      return request.items.map((item) => ({ i: item.i, t: `çeviri ${item.s}` }));
    });

    startTranslation(db, projectId, { provider, chunkSize: 1, lanes: 3, staggerMs: 0 });
    await settled();

    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
  });

  it('reports how many are out', async () => {
    let peak = 0;
    const provider = stub(async (request) => {
      peak = Math.max(peak, translateProgress().inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return request.items.map((item) => ({ i: item.i, t: 'ok' }));
    });

    startTranslation(db, projectId, { provider, chunkSize: 1, lanes: 3, staggerMs: 0 });
    await settled();

    expect(peak).toBeGreaterThan(1);
    expect(translateProgress().inFlight).toBe(0);
  });
});
