import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import type { Db } from '../db/open.ts';
import { exportProject } from '../project/export.ts';
import { entrySources, listTags, searchGlossary, updateEntry, type GlossaryQuery } from './glossary.ts';
import {
  listProjects,
  listUnits,
  overrideCheck,
  saveUnit,
  unitDetail,
  type UnitFilter,
} from './review.ts';
import {
  addSource,
  listSources,
  removeSource,
  reorderSources,
  startSync,
  syncProgress,
} from './sources.ts';

export interface ServerOptions {
  db: Db;
  port?: number;
  /** Built panel to serve at `/`. Omitted during development, when Vite serves it. */
  panelDir?: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

/**
 * The panel's back end.
 *
 * Bound to localhost only. There is no authentication because there are no
 * users (D13) — binding elsewhere would put an unauthenticated database on the
 * network, so it does not.
 */
export function startServer(options: ServerOptions): ReturnType<typeof createServer> {
  const server = createServer((request, response) => {
    handle(options, request, response).catch((error: unknown) => {
      send(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  server.listen(options.port ?? 4173, '127.0.0.1');
  return server;
}

async function handle(
  options: ServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const route = url.pathname;

  if (route.startsWith('/api/')) return api(options, request, response, url);
  if (options.panelDir) return serveStatic(options.panelDir, route, response);

  send(response, 404, { error: 'Not found' });
}

async function api(
  options: ServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  const { db } = options;
  const route = url.pathname;
  const method = request.method ?? 'GET';

  if (method === 'GET' && route === '/api/projects') {
    return send(response, 200, listProjects(db));
  }

  const units = /^\/api\/projects\/(\d+)\/units$/.exec(route);
  if (method === 'GET' && units) {
    return send(response, 200, listUnits(db, Number(units[1]), readFilter(url)));
  }

  const exportMatch = /^\/api\/projects\/(\d+)\/export$/.exec(route);
  if (method === 'GET' && exportMatch) {
    const result = exportProject(db, Number(exportMatch[1]));
    response.writeHead(200, {
      'content-type': 'text/x-gettext-translation; charset=utf-8',
      'content-disposition': 'attachment; filename="tr.po"',
      'x-exported': String(result.exported),
      'x-withheld': String(result.withheld),
    });
    return void response.end(result.po);
  }

  const detail = /^\/api\/units\/(\d+)\/detail$/.exec(route);
  if (method === 'GET' && detail) {
    return send(response, 200, unitDetail(db, Number(detail[1])));
  }

  const save = /^\/api\/units\/(\d+)$/.exec(route);
  if (method === 'POST' && save) {
    const body = await readJson(request);
    return send(response, 200, saveUnit(db, Number(save[1]), body));
  }

  const override = /^\/api\/units\/(\d+)\/override$/.exec(route);
  if (method === 'POST' && override) {
    const body = (await readJson(request)) as { rule: string; reason: string };
    overrideCheck(db, Number(override[1]), body.rule, body.reason);
    return send(response, 200, { ok: true });
  }

  if (method === 'GET' && route === '/api/tags') return send(response, 200, listTags(db));

  if (route === '/api/sources') {
    if (method === 'GET') return send(response, 200, listSources(db));
    if (method === 'POST') {
      const body = (await readJson(request)) as { url: string; tagIds?: number[]; label?: string };
      const id = addSource(db, body.url, body.tagIds ?? [], body.label);
      return send(response, 200, { id });
    }
  }

  const source = /^\/api\/sources\/(\d+)$/.exec(route);
  if (method === 'DELETE' && source) {
    removeSource(db, Number(source[1]));
    return send(response, 200, { ok: true });
  }

  if (method === 'POST' && route === '/api/sources/reorder') {
    const body = (await readJson(request)) as { ids: number[] };
    reorderSources(db, body.ids);
    return send(response, 200, { ok: true });
  }

  if (route === '/api/sources/sync') {
    if (method === 'POST') return send(response, 200, startSync(db));
    if (method === 'GET') return send(response, 200, syncProgress());
  }

  if (method === 'GET' && route === '/api/glossary') {
    return send(response, 200, searchGlossary(db, readGlossaryQuery(url)));
  }

  const entry = /^\/api\/glossary\/(\d+)$/.exec(route);
  if (entry) {
    if (method === 'GET') return send(response, 200, entrySources(db, Number(entry[1])));
    if (method === 'POST') {
      const body = (await readJson(request)) as { translation: string };
      return send(response, 200, updateEntry(db, Number(entry[1]), body.translation));
    }
  }

  send(response, 404, { error: `No route for ${method} ${route}` });
}

function readFilter(url: URL): UnitFilter {
  const filter: UnitFilter = {};
  const state = url.searchParams.get('state');
  if (state === 'untranslated' || state === 'review' || state === 'ok') filter.state = state;
  if (url.searchParams.get('blocked') === '1') filter.blocked = true;
  if (url.searchParams.get('ambiguous') === '1') filter.ambiguous = true;

  const search = url.searchParams.get('q');
  if (search) filter.search = search;

  const limit = Number(url.searchParams.get('limit'));
  if (Number.isFinite(limit) && limit > 0) filter.limit = limit;

  return filter;
}

function readGlossaryQuery(url: URL): GlossaryQuery {
  const query: GlossaryQuery = {};
  const search = url.searchParams.get('q');
  if (search) query.search = search;

  const tagId = Number(url.searchParams.get('tag'));
  if (Number.isFinite(tagId) && tagId > 0) query.tagId = tagId;

  const kind = url.searchParams.get('kind');
  if (kind === 'memory' || kind === 'term') query.kind = kind;
  if (url.searchParams.get('contested') === '1') query.contested = true;

  const limit = Number(url.searchParams.get('limit'));
  if (Number.isFinite(limit) && limit > 0) query.limit = Math.min(limit, 500);

  const offset = Number(url.searchParams.get('offset'));
  if (Number.isFinite(offset) && offset > 0) query.offset = offset;

  return query;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString('utf-8');
  return body ? (JSON.parse(body) as Record<string, unknown>) : {};
}

async function serveStatic(root: string, route: string, response: ServerResponse): Promise<void> {
  // Any unknown path falls back to index.html so the panel can own its routing.
  const relative = normalize(route === '/' ? 'index.html' : route.slice(1));
  if (relative.startsWith('..')) return send(response, 403, { error: 'Forbidden' });

  try {
    const file = await readFile(join(root, relative));
    response.writeHead(200, { 'content-type': MIME[extname(relative)] ?? 'application/octet-stream' });
    response.end(file);
  } catch {
    try {
      const index = await readFile(join(root, 'index.html'));
      response.writeHead(200, { 'content-type': MIME['.html']! });
      response.end(index);
    } catch {
      send(response, 404, { error: 'Panel is not built. Run `npm run build:panel`.' });
    }
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}
