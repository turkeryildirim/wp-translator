import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { listSources, startSync, syncProgress } from '../src/server/sources.ts';

const PO = `msgid ""
msgstr "Content-Type: text/plain; charset=UTF-8\\n"

msgid "Save"
msgstr "Kaydet"
`;
const CSV = 'en,tr,pos,comment,description\nsave,kaydet,verb,,\n';

let db: Db;
let fetched: string[];

/** Nothing here touches the network; the point is which URLs are asked for. */
const stubNetwork = (): void => {
  vi.stubGlobal('fetch', (input: string) => {
    fetched.push(String(input));
    const body = String(input).endsWith('.csv') || String(input).includes('glossary') ? CSV : PO;
    return Promise.resolve(new Response(body, { status: 200 }));
  });
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 2000 && syncProgress().running; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(syncProgress().running).toBe(false);
};

beforeEach(() => {
  db = openDb(':memory:');
  fetched = [];
  stubNetwork();
});
afterEach(() => vi.unstubAllGlobals());

describe('updating only the picked sources', () => {
  it('fetches those and no others', async () => {
    // The point of the action: one source re-translated upstream is worth
    // re-fetching on its own, and waiting for the other forty is not.
    const picked = listSources(db).slice(0, 3);

    const started = startSync(db, picked.map((source) => source.id));
    expect(started.partial).toBe(true);
    expect(started.total).toBe(3);

    await settle();
    expect(syncProgress().done).toBe(3);
    for (const source of picked) {
      expect(fetched.some((url) => url.includes(source.projectPath))).toBe(true);
    }
    expect(fetched).toHaveLength(3);
  });

  it('leaves the official term list alone', async () => {
    // Picking a few sources says nothing about the terminology being stale, and
    // it is not one of these sources.
    await (async () => {
      startSync(db, [listSources(db)[0]!.id]);
      await settle();
    })();

    expect(syncProgress().glossaryTerms).toBeNull();
    expect(fetched.some((url) => url.includes('glossary'))).toBe(false);
  });

  it('still refreshes the term list when nothing is picked', async () => {
    startSync(db);
    await settle();

    expect(syncProgress().partial).toBe(false);
    expect(syncProgress().glossaryTerms).not.toBeNull();
    expect(fetched.some((url) => url.includes('glossary'))).toBe(true);
  });

  it('counts a full run as sources plus the term list', () => {
    const total = startSync(db).total;
    expect(total).toBe(listSources(db).length + 1);
  });
});
