import type { Family } from './project.ts';

export interface ProjectMetadata {
  name?: string;
  version?: string;
  description?: string;
  readme?: string;
  tags?: string[];
  downloadUrl?: string;
}

/**
 * Fetch what wordpress.org knows about a project.
 *
 * Only plugins and themes are slug-addressable; `wp`, `apps`, `meta` and
 * `patterns` are WordPress's own projects with no info API and no ZIP, so
 * for those this returns nothing and the owner supplies the tags directly.
 */
export async function fetchMetadata(
  family: Family,
  slug: string | undefined,
): Promise<ProjectMetadata> {
  if (!slug || (family !== 'plugin' && family !== 'theme')) return {};

  const url =
    family === 'plugin'
      ? `https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request%5Bslug%5D=${encodeURIComponent(slug)}`
      : `https://api.wordpress.org/themes/info/1.2/?action=theme_information&request%5Bslug%5D=${encodeURIComponent(slug)}` +
        '&request%5Bfields%5D%5Btags%5D=1&request%5Bfields%5D%5Bsections%5D=1';

  const response = await fetch(url);
  if (!response.ok) return {};

  const body = (await response.json()) as {
    name?: string;
    version?: string;
    short_description?: string;
    download_link?: string;
    tags?: Record<string, string> | string[];
    sections?: Record<string, string>;
  };

  const metadata: ProjectMetadata = {};
  if (body.name) metadata.name = stripTags(body.name);
  if (body.version) metadata.version = body.version;
  if (body.short_description) metadata.description = stripTags(body.short_description);
  if (body.download_link) metadata.downloadUrl = body.download_link;

  const description = body.sections?.description;
  if (description) metadata.readme = stripTags(description).slice(0, 4000);

  const tags = body.tags;
  if (tags) metadata.tags = Array.isArray(tags) ? tags : Object.values(tags);

  return metadata;
}

const stripTags = (html: string): string =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#8217;/g, '’')
    .replace(/\s+/g, ' ')
    .trim();
