import { describe, expect, it } from 'vitest';
import { exportUrl, parseProjectUrl } from '../src/wporg/project.ts';

const P = 'https://translate.wordpress.org/projects';
const L = 'https://translate.wordpress.org/locale/tr/default';

describe('project URL parsing', () => {
  it.each([
    [`${P}/wp-plugins/woocommerce/dev/tr/default/`, 'plugin', 'wp-plugins/woocommerce/dev', 'dev'],
    [`${P}/wp-plugins/bbpress/dev-readme/tr/default/`, 'plugin', 'wp-plugins/bbpress/dev-readme', 'dev-readme'],
    [`${P}/wp-themes/twentytwentyone/tr/default/`, 'theme', 'wp-themes/twentytwentyone', undefined],
    [`${P}/wp/dev/tr/default/`, 'core', 'wp/dev', 'dev'],
    [`${P}/wp/dev/admin/network/tr/default/`, 'core', 'wp/dev/admin/network', undefined],
    [`${P}/apps/ios/release-notes/tr/default/`, 'apps', 'apps/ios/release-notes', 'release-notes'],
    [`${P}/meta/learn-wordpress/tr/default/`, 'meta', 'meta/learn-wordpress', undefined],
    [`${P}/patterns/core/tr/default/`, 'patterns', 'patterns/core', undefined],
  ])('reads %s', (url, family, projectPath, subProject) => {
    const ref = parseProjectUrl(url);

    expect(ref.family).toBe(family);
    expect(ref.projectPath).toBe(projectPath);
    expect(ref.subProject).toBe(subProject);
  });

  it('takes the slug for plugins and themes only', () => {
    expect(parseProjectUrl(`${P}/wp-plugins/woocommerce/dev/tr/default/`).slug).toBe('woocommerce');
    expect(parseProjectUrl(`${P}/wp-themes/twentytwentyone/tr/default/`).slug).toBe('twentytwentyone');
    expect(parseProjectUrl(`${P}/meta/forums/tr/default/`).slug).toBeUndefined();
  });

  it('reads the locale page form, which lists a project’s sub-projects', () => {
    expect(parseProjectUrl(`${L}/wp-plugins/ry-wc-city-select/`)).toMatchObject({
      family: 'plugin',
      projectPath: 'wp-plugins/ry-wc-city-select',
      slug: 'ry-wc-city-select',
    });
  });

  it('works without the trailing slash', () => {
    expect(parseProjectUrl(`${P}/meta/forums/tr/default`).projectPath).toBe('meta/forums');
  });

  it('rejects an unknown family', () => {
    expect(() => parseProjectUrl(`${P}/wp-mobile/foo/tr/default/`)).toThrow(/Unknown project family/);
  });

  it('rejects a URL that is not a project', () => {
    expect(() => parseProjectUrl('https://translate.wordpress.org/')).toThrow(/Not a translate/);
  });
});

describe('export URL', () => {
  it('asks for current translations only', () => {
    // `waiting` is unreviewed and would dilute the glossary (D26).
    expect(exportUrl('wp/dev')).toBe(
      'https://translate.wordpress.org/projects/wp/dev/tr/default/export-translations/' +
        '?format=po&filters%5Bstatus%5D=current',
    );
  });

  it('round-trips a parsed URL', () => {
    const ref = parseProjectUrl(`${P}/apps/ios/dev/tr/default/`);
    expect(exportUrl(ref.projectPath)).toContain('/projects/apps/ios/dev/tr/default/');
  });
});
