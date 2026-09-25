import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import type { Db } from '../db/open.ts';
import { applyGlossary } from '../glossary/match.ts';
import { exportProject } from '../project/export.ts';
import {
  entryContexts,
  entrySources,
  listTags,
  searchGlossary,
  updateEntry,
  type GlossaryQuery,
} from './glossary.ts';
import {
  bulkSetState,
  listProjects,
  listUnits,
  unitIdsFor,
  overrideCheck,
  saveUnit,
  unitDetail,
  type QueueView,
  type UnitFilter,
} from './review.ts';
import { addProject, bulkApprove, ownWork, reloadProject, removeProject } from './projects.ts';
import {
  startTranslation,
  stopTranslation,
  translateProgress,
  type TranslateScope,
} from './translate.ts';
import {
  createTag,
  listStyleRules,
  mergeTags,
  previewMerge,
  renameTag,
  saveStyleRule,
  type MergePolicy,
} from './tags.ts';
import {
  addSource,
  bulkTagSources,
  listSources,
  normaliseProjectUrl,
  removeSources,
  reorderSources,
  setSourceTags,
  startSync,
  syncProgress,
  verifyProjectUrl,
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
 * users — binding elsewhere would put an unauthenticated database on the
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
      const url = normaliseProjectUrl(body.url);
      await verifyProjectUrl(url);
      return send(response, 200, { id: addSource(db, url, body.tagIds ?? [], body.label) });
    }
  }

  const source = /^\/api\/sources\/(\d+)$/.exec(route);
  if (method === 'DELETE' && source) {
    removeSources(db, [Number(source[1])]);
    return send(response, 200, { ok: true });
  }

  if (method === 'POST' && route === '/api/sources/bulk-delete') {
    const body = (await readJson(request)) as { ids: number[] };
    return send(response, 200, { removed: removeSources(db, body.ids) });
  }

  if (method === 'POST' && route === '/api/sources/bulk-tags') {
    const body = (await readJson(request)) as { ids: number[]; add?: number[]; remove?: number[] };
    const change: { add?: number[]; remove?: number[] } = {};
    if (body.add) change.add = body.add;
    if (body.remove) change.remove = body.remove;
    return send(response, 200, { changed: bulkTagSources(db, body.ids, change) });
  }

  const sourceTags = /^\/api\/sources\/(\d+)\/tags$/.exec(route);
  if (method === 'POST' && sourceTags) {
    const body = (await readJson(request)) as { tagIds: number[] };
    setSourceTags(db, Number(sourceTags[1]), body.tagIds);
    return send(response, 200, { ok: true });
  }

  if (method === 'POST' && route === '/api/sources/reorder') {
    const body = (await readJson(request)) as { ids: number[] };
    reorderSources(db, body.ids);
    return send(response, 200, { ok: true });
  }

  if (route === '/api/sources/sync') {
    if (method === 'POST') {
      const body = (await readJson(request)) as { ids?: number[] } | null;
      return send(response, 200, startSync(db, body?.ids));
    }
    if (method === 'GET') return send(response, 200, syncProgress());
  }

  if (method === 'GET' && route === '/api/glossary') {
    return send(response, 200, searchGlossary(db, readGlossaryQuery(url)));
  }

  const entry = /^\/api\/glossary\/(\d+)$/.exec(route);
  if (entry) {
    if (method === 'GET') {
      const id = Number(entry[1]);
      return send(response, 200, { sources: entrySources(db, id), contexts: entryContexts(db, id) });
    }
    if (method === 'POST') {
      const body = (await readJson(request)) as {
        translation: string;
        translationPlural?: string;
      };
      return send(
        response,
        200,
        updateEntry(db, Number(entry[1]), body.translation, body.translationPlural),
      );
    }
  }

  if (method === 'POST' && route === '/api/tags') {
    const body = (await readJson(request)) as { name: string };
    return send(response, 200, { id: createTag(db, body.name) });
  }

  const tag = /^\/api\/tags\/(\d+)$/.exec(route);
  if (method === 'POST' && tag) {
    const body = (await readJson(request)) as { name: string };
    renameTag(db, Number(tag[1]), body.name);
    return send(response, 200, { ok: true });
  }

  if (method === 'POST' && route === '/api/tags/merge') {
    const body = (await readJson(request)) as {
      from: number;
      to: number;
      policy?: MergePolicy;
      preview?: boolean;
    };
    return send(
      response,
      200,
      body.preview
        ? previewMerge(db, body.from, body.to)
        : mergeTags(db, body.from, body.to, body.policy),
    );
  }

  if (route === '/api/style-rules') {
    if (method === 'GET') return send(response, 200, listStyleRules(db));
    if (method === 'POST') {
      const body = (await readJson(request)) as { tagId: number | null; body: string };
      saveStyleRule(db, body.tagId, body.body);
      return send(response, 200, { ok: true });
    }
  }

  if (method === 'POST' && route === '/api/projects') {
    const body = (await readJson(request)) as { url: string; tagIds?: number[] };
    return send(response, 200, await addProject(db, body.url, body.tagIds ?? []));
  }

  const project = /^\/api\/projects\/(\d+)$/.exec(route);
  if (method === 'DELETE' && project) {
    removeProject(db, Number(project[1]));
    return send(response, 200, { ok: true });
  }

  const translate = /^\/api\/projects\/(\d+)\/translate$/.exec(route);
  if (translate) {
    if (method === 'POST') {
      const body = (await readJson(request)) as {
        chunkSize?: number;
        model?: string;
        agent?: string;
        scope?: TranslateScope;
        ids?: number[];
      };
      return send(response, 200, startTranslation(db, Number(translate[1]), body));
    }
    if (method === 'GET') return send(response, 200, translateProgress());
    if (method === 'DELETE') return send(response, 200, stopTranslation());
  }

  const reload = /^\/api\/projects\/(\d+)\/reload$/.exec(route);
  if (reload) {
    const projectId = Number(reload[1]);
    // GET says what a reload would cost, so the panel can name the number in
    // its confirmation rather than warning in the abstract.
    if (method === 'GET') return send(response, 200, { discards: ownWork(db, projectId) });
    if (method === 'POST') return send(response, 200, await reloadProject(db, projectId));
  }

  const bulkState = /^\/api\/projects\/(\d+)\/bulk$/.exec(route);
  if (method === 'POST' && bulkState) {
    const body = (await readJson(request)) as {
      action: 'approve' | 'clear' | 'glossary';
      ids?: number[];
      filter?: string;
    };
    const projectId = Number(bulkState[1]);
    const target = body.ids
      ? { ids: body.ids }
      : { filter: readFilter(new URL(`http://x/?${body.filter ?? ''}`)) };

    if (body.action === 'glossary') {
      const ids =
        'ids' in target ? target.ids : unitIdsFor(db, projectId, target.filter);
      const result = applyGlossary(db, projectId, ids);
      return send(response, 200, { changed: result.filled, skipped: result.unmatched });
    }
    return send(response, 200, bulkSetState(db, projectId, target, body.action));
  }

  if (method === 'POST' && route === '/api/units/bulk-approve') {
    const body = (await readJson(request)) as { ids: number[] };
    return send(response, 200, bulkApprove(db, body.ids));
  }

  send(response, 404, { error: `No route for ${method} ${route}` });
}

const VIEWS = new Set<QueueView>([
  'all',
  'untranslated',
  'waiting',
  'translated',
  'blocked',
  'upstream',
]);

function readFilter(url: URL): UnitFilter {
  const filter: UnitFilter = {};
  const view = url.searchParams.get('view') as QueueView | null;
  if (view && VIEWS.has(view)) filter.view = view;

  const offset = Number(url.searchParams.get('offset'));
  if (Number.isFinite(offset) && offset > 0) filter.offset = offset;

  const search = url.searchParams.get('q');
  if (search) filter.search = search;
  if (url.searchParams.get('case') === '1') filter.caseSensitive = true;
  const filterScope = url.searchParams.get('in');
  if (filterScope === 'source' || filterScope === 'translation') filter.scope = filterScope;

  const limit = Number(url.searchParams.get('limit'));
  if (Number.isFinite(limit) && limit > 0) filter.limit = limit;

  return filter;
}

function readGlossaryQuery(url: URL): GlossaryQuery {
  const query: GlossaryQuery = {};
  const search = url.searchParams.get('q');
  if (search) query.search = search;
  if (url.searchParams.get('case') === '1') query.caseSensitive = true;
  const scope = url.searchParams.get('in');
  if (scope === 'source' || scope === 'translation') query.scope = scope;

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
