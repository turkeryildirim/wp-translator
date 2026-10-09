import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/open.ts';
import { ALLOWED_ORIGIN, startServer } from '../src/server/http.ts';

/**
 * What the browser is told about reaching this server from a page.
 *
 * The queue-walking userscript runs in translate.wordpress.org's own context, so
 * its requests are cross-origin and the browser — not this server — decides
 * whether they happen at all. Every assertion here is about a refusal that leaves
 * no trace on the server side.
 */
let server: ReturnType<typeof startServer>;
let base: string;

beforeAll(async () => {
  server = startServer({ db: openDb(':memory:'), port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

describe('who may call the API from a browser', () => {
  it('lets the queue-walking page through, and still answers the route', async () => {
    // Both halves matter: a CORS header on a request that was never routed is a
    // page that reaches the server and gets nothing out of it.
    const reply = await fetch(`${base}/api/health`, { headers: { origin: ALLOWED_ORIGIN } });

    expect(reply.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(await reply.json()).toEqual({ ok: true });
  });

  it('tells caches the answer depends on the origin', async () => {
    // Without this a cached response carries the permission to a page it was
    // never written for.
    const reply = await fetch(`${base}/api/health`, { headers: { origin: ALLOWED_ORIGIN } });

    expect(reply.headers.get('vary')).toMatch(/origin/i);
  });

  it('writes no permission for any other origin', async () => {
    const reply = await fetch(`${base}/api/health`, { headers: { origin: 'https://example.com' } });

    expect(reply.headers.get('access-control-allow-origin')).toBeNull();
    // Still answered: the server has no users and refusing here would only hide
    // what the browser is already enforcing.
    expect(reply.status).toBe(200);
  });

  it('answers a preflight without routing it', async () => {
    const reply = await fetch(`${base}/api/judge`, {
      method: 'OPTIONS',
      headers: {
        origin: ALLOWED_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });

    expect(reply.status).toBe(204);
    expect(reply.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(reply.headers.get('access-control-allow-methods')).toMatch(/POST/);
    expect(reply.headers.get('access-control-allow-headers')).toMatch(/content-type/);
  });

  it('grants the private-network access a page needs to reach 127.0.0.1', async () => {
    // An HTTPS page calling loopback is a private-network request. Chrome asks
    // for it on the preflight and blocks the real request in the browser when the
    // answer is missing — so the symptom is a request that never arrives and
    // nothing in the server's own log to explain it.
    const reply = await fetch(`${base}/api/health`, {
      method: 'OPTIONS',
      headers: {
        origin: ALLOWED_ORIGIN,
        'access-control-request-method': 'GET',
        'access-control-request-private-network': 'true',
      },
    });

    expect(reply.headers.get('access-control-allow-private-network')).toBe('true');
  });

  it('grants it to nobody else', async () => {
    const reply = await fetch(`${base}/api/health`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://example.com',
        'access-control-request-method': 'GET',
        'access-control-request-private-network': 'true',
      },
    });

    expect(reply.headers.get('access-control-allow-private-network')).toBeNull();
  });

  it('says nothing about origins outside the API', async () => {
    // The panel is served from this server and needs no permission; writing one
    // for the whole origin would hand it to every path there is.
    const reply = await fetch(`${base}/`, { headers: { origin: ALLOWED_ORIGIN } });

    expect(reply.headers.get('access-control-allow-origin')).toBeNull();
  });
});
