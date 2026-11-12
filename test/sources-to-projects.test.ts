import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { importSourcesToProjects } from '../src/server/projects.ts';
import { addSource, listSources } from '../src/server/sources.ts';

const samplePo = (strings: string[]): string =>
  ['msgid ""', 'msgstr ""', '']
    .concat(strings.flatMap((s) => [`msgid "${s}"`, 'msgstr ""', '']))
    .join('\n');

const mockFetch = (poStrings: string[] = ['Save', 'Cancel']) => {
  vi.stubGlobal('fetch', (url: string | URL) => {
    const urlStr = String(url);
    if (urlStr.includes('api.wordpress.org')) {
      return Promise.resolve(new Response(JSON.stringify({ name: 'Mock Metadata Name' }), { status: 200 }));
    }
    if (urlStr.includes('broken')) {
      return Promise.resolve(new Response('', { status: 404 }));
    }
    return Promise.resolve(new Response(samplePo(poStrings), { status: 200 }));
  });
};

describe('importing trusted sources into translation review projects', () => {
  let db: Db;
  let tagId: number;

  beforeEach(() => {
    db = openDb(':memory:');
    tagId = Number(db.prepare(`INSERT INTO tags (name) VALUES ('ecommerce')`).run().lastInsertRowid);
  });

  it('imports a trusted source into projects, preserving tags and label', async () => {
    mockFetch(['Add to cart', 'Checkout']);

    const sourceId = addSource(
      db,
      'https://translate.wordpress.org/projects/wp-plugins/custom-shop-plugin/dev/tr/default/',
      [tagId],
      'Custom Shop Plugin',
    );

    const result = await importSourcesToProjects(db, [sourceId]);

    expect(result.added).toHaveLength(1);
    expect(result.added[0]!.name).toBe('Custom Shop Plugin');
    expect(result.added[0]!.strings).toBe(2);
    expect(result.skipped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);

    // Verify project exists in projects table
    const proj = db
      .prepare(`SELECT id, name, project_path AS projectPath, translate_url AS translateUrl FROM projects WHERE id = ?`)
      .get(result.added[0]!.id) as { id: number; name: string; projectPath: string; translateUrl: string };
    expect(proj.name).toBe('Custom Shop Plugin');
    expect(proj.projectPath).toBe('wp-plugins/custom-shop-plugin/dev');

    // Verify project tags were copied over
    const projectTags = db
      .prepare(`SELECT tag_id AS tagId FROM project_tags WHERE project_id = ?`)
      .all(proj.id) as { tagId: number }[];
    expect(projectTags.map((t) => t.tagId)).toEqual([tagId]);

    // Verify listSources now returns existingProjectId
    const sources = listSources(db);
    const updatedSource = sources.find((s) => s.id === sourceId);
    expect(updatedSource?.existingProjectId).toBe(proj.id);
  });

  it('skips projects that are already added without throwing', async () => {
    mockFetch(['Save', 'Cancel']);

    const sourceId = addSource(
      db,
      'https://translate.wordpress.org/projects/wp-plugins/custom-unique-plugin/dev/tr/default/',
      [tagId],
      'Unique Plugin',
    );

    // Import first time
    const res1 = await importSourcesToProjects(db, [sourceId]);
    expect(res1.added).toHaveLength(1);

    // Import second time
    const res2 = await importSourcesToProjects(db, [sourceId]);
    expect(res2.added).toHaveLength(0);
    expect(res2.skipped).toHaveLength(1);
    expect(res2.skipped[0]!.name).toBe('Unique Plugin');
    expect(res2.skipped[0]!.reason).toContain('zaten');
  });

  it('records an error and continues with the rest if an export returns empty or fails', async () => {
    mockFetch(['Hello world']);

    const s1 = addSource(
      db,
      'https://translate.wordpress.org/projects/wp-plugins/broken/dev/tr/default/',
      [tagId],
      'Broken Plugin',
    );
    const s2 = addSource(
      db,
      'https://translate.wordpress.org/projects/wp-plugins/good-plugin/dev/tr/default/',
      [tagId],
      'Good Plugin',
    );

    const res = await importSourcesToProjects(db, [s1, s2]);
    expect(res.added).toHaveLength(1);
    expect(res.added[0]!.name).toBe('Good Plugin');
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.name).toBe('Broken Plugin');
  });
});
