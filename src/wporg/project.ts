export type Family = 'plugin' | 'theme' | 'core' | 'apps' | 'meta' | 'patterns';

export interface ProjectRef {
  family: Family;
  /** Path under `/projects/`, e.g. `wp-plugins/woocommerce/dev` or `wp/dev/admin/network`. */
  projectPath: string;
  /** `dev`, `stable`, `dev-readme`, … where the family has one. */
  subProject?: string;
  /** Plugins and themes only; the other families are not slug-addressable. */
  slug?: string;
}

const FAMILY_BY_SEGMENT: Record<string, Family> = {
  'wp-plugins': 'plugin',
  'wp-themes': 'theme',
  wp: 'core',
  apps: 'apps',
  meta: 'meta',
  patterns: 'patterns',
};

const SUB_PROJECTS = new Set([
  'dev',
  'stable',
  'dev-readme',
  'stable-readme',
  'release-notes',
]);

/**
 * Read a translate.wordpress.org project URL.
 *
 * The project space is not uniform (R8): plugins carry a sub-project, themes do
 * not, core nests two levels deep, and apps split by platform. Both URL forms
 * are accepted — the canonical `/projects/<path>/tr/default/` and the
 * `/locale/tr/default/<type>/<slug>/` page that lists a project's sub-projects.
 */
export function parseProjectUrl(url: string): ProjectRef {
  const { pathname } = new URL(url);
  const segments = pathname.split('/').filter(Boolean);

  const projectsAt = segments.indexOf('projects');
  const localeAt = segments.indexOf('locale');

  const path =
    projectsAt >= 0
      ? stripLocale(segments.slice(projectsAt + 1))
      : localeAt >= 0
        ? segments.slice(localeAt + 3)
        : [];

  if (path.length === 0) throw new Error(`Not a translate.wordpress.org project URL: ${url}`);

  const family = FAMILY_BY_SEGMENT[path[0]!];
  if (!family) throw new Error(`Unknown project family "${path[0]}" in: ${url}`);

  const ref: ProjectRef = { family, projectPath: path.join('/') };

  const last = path[path.length - 1]!;
  if (SUB_PROJECTS.has(last)) ref.subProject = last;
  if ((family === 'plugin' || family === 'theme') && path[1]) ref.slug = path[1];

  return ref;
}

/** Drop the trailing `tr/default` (or any other locale/set) from a project path. */
function stripLocale(segments: string[]): string[] {
  const defaultAt = segments.lastIndexOf('default');
  return defaultAt > 0 ? segments.slice(0, defaultAt - 1) : segments;
}

export interface ExportOptions {
  locale?: string;
  /** `current` only, by default: `waiting` is unreviewed and would dilute the glossary (D26). */
  status?: 'current' | 'waiting' | 'untranslated';
}

export function exportUrl(projectPath: string, options: ExportOptions = {}): string {
  const locale = options.locale ?? 'tr';
  const status = options.status ?? 'current';
  return (
    `https://translate.wordpress.org/projects/${projectPath}/${locale}/default/export-translations/` +
    `?format=po&filters%5Bstatus%5D=${status}`
  );
}
