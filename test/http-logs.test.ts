import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/open.ts';
import { startServer } from '../src/server/http.ts';
import { logMessage } from '../src/db/logs.ts';
import { remember } from '../src/ai/memory.ts';

let server: ReturnType<typeof startServer>;
let base: string;
let db: ReturnType<typeof openDb>;

beforeAll(async () => {
  db = openDb(':memory:');
  server = startServer({ db, port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  db.close();
});

describe('HTTP /api/logs and /api/memory routes', () => {
  it('lists and clears system logs via HTTP API', async () => {
    logMessage(db, { level: 'info', category: 'test', message: 'Test log 1' });
    logMessage(db, { level: 'error', category: 'test', message: 'Test log 2' });

    // Fetch logs
    const getRes = await fetch(`${base}/api/logs`);
    expect(getRes.status).toBe(200);
    const data = (await getRes.json()) as { total: number; entries: any[] };
    expect(data.total).toBe(2);
    expect(data.entries.length).toBe(2);

    // Delete logs
    const delRes = await fetch(`${base}/api/logs`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    const delData = (await delRes.json()) as { deleted: number };
    expect(delData.deleted).toBe(2);

    // Verify empty
    const getAfter = await fetch(`${base}/api/logs`);
    const afterData = (await getAfter.json()) as { total: number; entries: any[] };
    expect(afterData.total).toBe(0);
    expect(afterData.entries.length).toBe(0);
  });

  it('deletes memory item by ID via DELETE /api/memory/:id', async () => {
    remember(db, {
      kind: 'translation',
      keyHash: 'test-hash',
      rulesHash: 'test-rules',
      sourceText: 'test',
      question: {},
      answer: {},
      model: 'test',
    });

    const entries = db.prepare('SELECT id FROM ai_memory').all() as { id: number }[];
    const id = entries[0]!.id;

    const delRes = await fetch(`${base}/api/memory/${id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    const data = (await delRes.json()) as { deleted: boolean };
    expect(data.deleted).toBe(true);
  });
});
