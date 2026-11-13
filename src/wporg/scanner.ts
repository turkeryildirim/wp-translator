export interface QueueProject {
  family: 'plugin' | 'theme';
  slug: string;
  name: string;
  waitingCount: number;
  url: string;
}

export interface QueueTarget {
  family: 'plugin' | 'theme';
  slug: string;
  name: string;
  subProject?: string | undefined;
  projectPath: string;
  queueUrl: string;
  status: 'waiting' | 'fuzzy';
  count: number;
}

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

const PAIRS: readonly [string, string][] = [
  ['dev', 'stable'],
  ['dev-readme', 'stable-readme'],
];

function decodeHtml(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&hellip;/g, '…')
    .trim();
}

function parseCount(text?: string | null): number {
  if (!text) return 0;
  const digits = text.replace(/[^\d]/g, '');
  return digits ? parseInt(digits, 10) : 0;
}

/**
 * Parses projects from a locale overview listing
 * (e.g. /locale/tr/default/wp-plugins/?filter=strings-waiting-and-fuzzy).
 */
export function parseWaitingProjects(html: string, family: 'plugin' | 'theme'): QueueProject[] {
  const projects: QueueProject[] = [];
  const projectRegex =
    /<div[^>]*class="[^"]*\bproject\b[^"]*"[^>]*>[\s\S]*?<div class="project-name"[^>]*>[\s\S]*?<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<div class="project-status-waiting"[^>]*>[\s\S]*?<span class="project-status-value"[^>]*>([\s\S]*?)<\/span>[\s\S]*?<\/div>/gi;

  let m: RegExpExecArray | null;
  while ((m = projectRegex.exec(html)) !== null) {
    const rawUrl = m[1] ?? '';
    const rawName = m[2] ?? '';
    const rawWaiting = m[3] ?? '';

    const slugMatch = new RegExp(`/locale/tr/default/wp-${family}s/([^/]+)/`, 'i').exec(rawUrl);
    const slug = slugMatch && slugMatch[1] ? slugMatch[1] : '';
    if (!slug) continue;

    const waitingCount = parseCount(rawWaiting);
    const name = decodeHtml(rawName.replace(/<[^>]+>/g, ''));
    const fullUrl = rawUrl.startsWith('http') ? rawUrl : `https://translate.wordpress.org${rawUrl}`;

    projects.push({
      family,
      slug,
      name,
      waitingCount,
      url: fullUrl,
    });
  }

  return projects;
}

/**
 * Chooses active sub-project targets for a project.
 * For plugins: balances trunk (dev) and released (stable) queues using chooseSets logic.
 * For themes: uses the root theme project set.
 */
export function parseSubProjectTargets(
  html: string,
  family: 'plugin' | 'theme',
  slug: string,
  name: string,
): QueueTarget[] {
  const targets: QueueTarget[] = [];

  if (family === 'theme') {
    const rowMatch =
      /<tr[^>]*>[\s\S]*?<td class="stats fuzzy"[^>]*>[\s\S]*?<a[^>]*>([\d,.]+)<\/a>[\s\S]*?<td class="stats waiting"[^>]*>[\s\S]*?<a[^>]*>([\d,.]+)<\/a>/i.exec(
        html,
      );
    const fuzzy = parseCount(rowMatch?.[1]);
    const waiting = parseCount(rowMatch?.[2]);
    const projectPath = `wp-themes/${slug}`;
    const baseUrl = `https://translate.wordpress.org/projects/${projectPath}/tr/default/`;

    if (waiting > 0) {
      targets.push({
        family: 'theme',
        slug,
        name,
        projectPath,
        queueUrl: `${baseUrl}?filters%5Btranslated%5D=yes&filters%5Bstatus%5D=waiting`,
        status: 'waiting',
        count: waiting,
      });
    }
    if (fuzzy > 0) {
      targets.push({
        family: 'theme',
        slug,
        name,
        projectPath,
        queueUrl: `${baseUrl}?filters%5Btranslated%5D=yes&filters%5Bstatus%5D=fuzzy`,
        status: 'fuzzy',
        count: fuzzy,
      });
    }
    return targets;
  }

  // Plugin sub-projects table
  const subProjects: Record<string, { waiting: number; fuzzy: number; path: string }> = {};

  const rowRegex =
    /<tr[^>]*>[\s\S]*?<td class="set-name"[^>]*>[\s\S]*?<a href="([^"]+)"[^>]*>[\s\S]*?<\/a>[\s\S]*?<td class="stats fuzzy"[^>]*>[\s\S]*?<a[^>]*>([\d,.]+)<\/a>[\s\S]*?<td class="stats waiting"[^>]*>[\s\S]*?<a[^>]*>([\d,.]+)<\/a>[\s\S]*?<\/tr>/gi;

  let rm: RegExpExecArray | null;
  while ((rm = rowRegex.exec(html)) !== null) {
    const href = rm[1] ?? '';
    const fuzzy = parseCount(rm[2]);
    const waiting = parseCount(rm[3]);

    const kindMatch = /^\/projects\/wp-plugins\/[^/]+\/([^/]+)\//.exec(href);
    const kind = kindMatch && kindMatch[1] ? kindMatch[1] : '';
    if (!kind) continue;

    const pathMatch = /\/projects\/(.+?)\/tr\/default\//.exec(href);
    const projectPath = pathMatch && pathMatch[1] ? pathMatch[1] : `wp-plugins/${slug}/${kind}`;

    subProjects[kind] = { waiting, fuzzy, path: projectPath };
  }

  // Choose sets between trunk and released pairs
  const pendingByKind: Record<string, number> = {};
  for (const [kind, stats] of Object.entries(subProjects)) {
    pendingByKind[kind] = stats.waiting + stats.fuzzy;
  }

  const chosenKinds: string[] = [];
  for (const [trunk, released] of PAIRS) {
    const onTrunk = pendingByKind[trunk] ?? 0;
    const onReleased = pendingByKind[released] ?? 0;
    if (onTrunk === 0 && onReleased === 0) continue;
    chosenKinds.push(onReleased > onTrunk ? released : trunk);
  }

  for (const kind of chosenKinds) {
    const set = subProjects[kind];
    if (!set) continue;
    const baseUrl = `https://translate.wordpress.org/projects/${set.path}/tr/default/`;

    if (set.waiting > 0) {
      targets.push({
        family: 'plugin',
        slug,
        name,
        subProject: kind,
        projectPath: set.path,
        queueUrl: `${baseUrl}?filters%5Btranslated%5D=yes&filters%5Bstatus%5D=waiting`,
        status: 'waiting',
        count: set.waiting,
      });
    }
    if (set.fuzzy > 0) {
      targets.push({
        family: 'plugin',
        slug,
        name,
        subProject: kind,
        projectPath: set.path,
        queueUrl: `${baseUrl}?filters%5Btranslated%5D=yes&filters%5Bstatus%5D=fuzzy`,
        status: 'fuzzy',
        count: set.fuzzy,
      });
    }
  }

  return targets;
}

export interface ScanOptions {
  cookie: string;
  family?: 'plugin' | 'theme' | 'all' | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Scans translate.wordpress.org for all plugins and themes with pending/waiting queues.
 */
export async function scanQueueTargets(options: ScanOptions): Promise<QueueTarget[]> {
  const families: ('plugin' | 'theme')[] =
    options.family === 'plugin' ? ['plugin'] : options.family === 'theme' ? ['theme'] : ['plugin', 'theme'];

  const allTargets: QueueTarget[] = [];

  for (const family of families) {
    if (options.signal?.aborted) break;

    const listUrl = `https://translate.wordpress.org/locale/tr/default/wp-${family}s/?filter=strings-waiting-and-fuzzy`;
    const listInit: RequestInit = {
      headers: {
        Cookie: options.cookie.trim(),
        'User-Agent': DEFAULT_USER_AGENT,
      },
    };
    if (options.signal) listInit.signal = options.signal;
    const res = await fetch(listUrl, listInit);

    if (!res.ok) {
      throw new Error(`WordPress.org ${family} bekleme listesi alınamadı (HTTP ${res.status}).`);
    }

    const html = await res.text();
    const projects = parseWaitingProjects(html, family);

    for (const proj of projects) {
      if (options.signal?.aborted) break;

      // Fetch detail page for subprojects
      const projInit: RequestInit = {
        headers: {
          Cookie: options.cookie.trim(),
          'User-Agent': DEFAULT_USER_AGENT,
        },
      };
      if (options.signal) projInit.signal = options.signal;
      const projRes = await fetch(proj.url, projInit);

      if (!projRes.ok) continue;
      const projHtml = await projRes.text();
      const targets = parseSubProjectTargets(projHtml, family, proj.slug, proj.name);
      allTargets.push(...targets);
    }
  }

  return allTargets;
}
