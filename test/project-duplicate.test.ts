import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { importProject } from '../src/project/import.ts';
import { addProject } from '../src/server/projects.ts';

describe('refusing duplicate project', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
    importProject(
      db,
      {
        family: 'plugin',
        projectPath: 'wp-plugins/woocommerce',
        subProject: 'dev',
        translateUrl: 'https://translate.wordpress.org/projects/wp-plugins/woocommerce/dev/tr/default/',
        name: 'WooCommerce',
      },
      { headers: {}, units: [] },
    );
  });

  it('rejects adding an already existing project with a friendly error without fetching', async () => {
    await expect(
      addProject(db, 'https://translate.wordpress.org/projects/wp-plugins/woocommerce/dev/tr/default/', []),
    ).rejects.toThrow(/Bu proje zaten eklenmiş: "WooCommerce \(dev\)"/);
  });
});
