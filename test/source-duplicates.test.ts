import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/open.ts';
import { addSource, listSources, normaliseProjectUrl } from '../src/server/sources.ts';

let db: Db;
let tagId: number;

beforeEach(() => {
  db = openDb(':memory:');
  tagId = (db.prepare(`SELECT id FROM tags WHERE name = 'wordpress'`).get() as { id: number }).id;
  db.prepare(`DELETE FROM trusted_sources`).run();
});

const add = (url: string) => addSource(db, normaliseProjectUrl(url), [tagId]);

describe('adding a trusted source twice', () => {
  const canonical = 'https://translate.wordpress.org/projects/wp-plugins/woocommerce/dev/tr/default/';

  it('refuses the same address', () => {
    add(canonical);

    expect(() => add(canonical)).toThrow(/zaten var/);
    expect(listSources(db).length).toBe(1);
  });

  it('refuses the same project written without the locale', () => {
    // The address is what the owner pastes; the project is what a source is. Both
    // of these are one project, and two rows would sync it twice and let it vouch
    // for its own entries twice.
    add(canonical);

    expect(() => add('https://translate.wordpress.org/projects/wp-plugins/woocommerce/dev/')).toThrow(
      /zaten var/,
    );
  });

  it('refuses the locale listing form outright, so it cannot become a second row', () => {
    // `parseProjectUrl` reads this form, but `normaliseProjectUrl` does not accept
    // it, so it never reaches the table at all. Asserted because that is the only
    // reason this spelling is not a way in.
    add(canonical);

    expect(() =>
      add('https://translate.wordpress.org/locale/tr/default/wp-plugins/woocommerce/dev/'),
    ).toThrow(/proje adresi değil/);
    expect(listSources(db).length).toBe(1);
  });

  it('refuses the same project with a query string on the end', () => {
    add(canonical);

    expect(() => add(`${canonical}?filters%5Bstatus%5D=current`)).toThrow(/zaten var/);
  });

  it('names what is already there, so the refusal can be acted on', () => {
    addSource(db, canonical, [tagId], 'WooCommerce');

    expect(() => add(canonical)).toThrow(/WooCommerce/);
  });

  it('still takes a different sub-project of the same plugin', () => {
    // `dev` and `dev-readme` are separate catalogues, not one project twice.
    add(canonical);
    add('https://translate.wordpress.org/projects/wp-plugins/woocommerce/dev-readme/tr/default/');

    expect(listSources(db).length).toBe(2);
  });

  it('still takes a different project', () => {
    add(canonical);
    add('https://translate.wordpress.org/projects/wp-plugins/bbpress/dev/tr/default/');

    expect(listSources(db).length).toBe(2);
  });
});
