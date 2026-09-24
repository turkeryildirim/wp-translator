import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Migration {
  version: number;
  sql: string;
}

const initialSchema = (): string =>
  readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf-8');

/**
 * The seeded Turkish style guide.
 *
 * Read from the repository file rather than copied into a string literal, so
 * `style-guide/tr-genel.md` stays the single copy. Seeding happens once, on a
 * database's first open, so later edits in the panel are never overwritten.
 */
const styleGuide = (): string => {
  try {
    return readFileSync(
      fileURLToPath(new URL('../../style-guide/tr-genel.md', import.meta.url)),
      'utf-8',
    );
  } catch {
    return '';
  }
};

/**
 * Forward-only, applied in order, each inside a transaction with
 * `PRAGMA user_version` moved to match.
 *
 * `schema.sql` is version 1 and is not edited again — later changes are
 * migrations, so a database created months ago and one created today end up
 * identical rather than merely similar.
 */
export const migrations: readonly Migration[] = [
  { version: 1, get sql() { return initialSchema(); } },
  {
    version: 2,
    // The official WordPress Turkish glossary distinguishes terms by part of
    // speech — `archive` is `arşiv` as a noun and `arşivle` as a verb — which is
    // the item→ürün/öge problem at term level. It cannot live in `msgctxt`:
    // that column is written verbatim into exported PO files, so a term entry
    // matching a whole string would corrupt the output.
    sql: `
      ALTER TABLE glossary_entries ADD COLUMN pos TEXT;
      ALTER TABLE glossary_entries ADD COLUMN note TEXT;

      -- Two invariants, not one, because the table now holds two kinds of row.
      --
      -- Translation memory (pos IS NULL): one translation per source, context
      -- and tag. D29 and D37 depend on a second one being impossible to add
      -- silently — it must surface as a constraint violation.
      --
      -- Terminology (pos IS NOT NULL): the official glossary deliberately offers
      -- alternatives under one part of speech — 'author' is both 'yazar' and
      -- 'geliştirici' as a noun — so the translation belongs in the key. Folding
      -- them together would make the import overwrite itself on every run.
      DROP INDEX idx_glossary_key;

      CREATE UNIQUE INDEX idx_glossary_memory_key
        ON glossary_entries (source_hash, ifnull(msgctxt, ''), tag_id)
        WHERE pos IS NULL;

      CREATE UNIQUE INDEX idx_glossary_term_key
        ON glossary_entries (source_hash, pos, translation, tag_id)
        WHERE pos IS NOT NULL;

      CREATE INDEX idx_glossary_term_lookup
        ON glossary_entries (tag_id, source_text);
    `,
  },
  {
    version: 3,
    // The export has to carry the catalogue's own headers back out: Plural-Forms
    // decides how many msgstr slots an entry has (R3), and Language names the
    // locale. Regenerating them would work for GlotPress, which matches on
    // entries, but it would quietly discard whatever else the project declared.
    sql: `ALTER TABLE projects ADD COLUMN po_headers TEXT;`,
  },
  {
    version: 4,
    // Which tags a source writes into. syncTrustedSource took these as an
    // argument, which is fine for a script but leaves the panel with nowhere to
    // record the owner's choice.
    sql: `
      CREATE TABLE trusted_source_tags (
        trusted_source_id INTEGER NOT NULL REFERENCES trusted_sources(id) ON DELETE CASCADE,
        tag_id            INTEGER NOT NULL REFERENCES tags(id)            ON DELETE CASCADE,
        PRIMARY KEY (trusted_source_id, tag_id)
      ) STRICT, WITHOUT ROWID;

      CREATE INDEX idx_trusted_source_tags_tag ON trusted_source_tags (tag_id);
    `,
  },
  {
    version: 5,
    // The owner's list, seeded so a fresh database is usable without adding 41
    // sources by hand. They are human-translated, reviewed by several people
    // over years, and kept current — not error-free, since the quality checks
    // found 51 defects across five of them, but authoritative.
    //
    // All land under one `wordpress` tag. Splitting them is the owner's call:
    // separating WooCommerce into its own tag is what makes `item` come out as
    // `ürün` there and `öge` elsewhere, and until that split exists the two
    // senses share a tag and the first one synced wins.
    //
    // Rank is the file order — core first, then the large plugins, then apps and
    // meta. It decides most disagreements (R15), so it is a starting point the
    // owner reorders rather than a fact.
    sql: `
      INSERT OR IGNORE INTO tags (name) VALUES ('wordpress');

      INSERT OR IGNORE INTO trusted_sources (translate_url, family, project_path, label, rank)
      VALUES
        ('https://translate.wordpress.org/projects/wp/dev/tr/default/', 'core', 'wp/dev', 'wp/dev', 1),
        ('https://translate.wordpress.org/projects/wp/dev/cc/tr/default/', 'core', 'wp/dev/cc', 'wp/dev/cc', 2),
        ('https://translate.wordpress.org/projects/wp/dev/admin/tr/default/', 'core', 'wp/dev/admin', 'wp/dev/admin', 3),
        ('https://translate.wordpress.org/projects/wp/dev/admin/network/tr/default/', 'core', 'wp/dev/admin/network', 'wp/dev/admin/network', 4),
        ('https://translate.wordpress.org/projects/wp-plugins/gutenberg/dev/tr/default/', 'plugin', 'wp-plugins/gutenberg/dev', 'wp-plugins/gutenberg/dev', 5),
        ('https://translate.wordpress.org/projects/wp-plugins/gutenberg/dev-readme/tr/default/', 'plugin', 'wp-plugins/gutenberg/dev-readme', 'wp-plugins/gutenberg/dev-readme', 6),
        ('https://translate.wordpress.org/projects/wp-plugins/woocommerce/dev/tr/default/', 'plugin', 'wp-plugins/woocommerce/dev', 'wp-plugins/woocommerce/dev', 7),
        ('https://translate.wordpress.org/projects/wp-plugins/woocommerce/dev-readme/tr/default/', 'plugin', 'wp-plugins/woocommerce/dev-readme', 'wp-plugins/woocommerce/dev-readme', 8),
        ('https://translate.wordpress.org/projects/wp-plugins/buddypress/dev/tr/default/', 'plugin', 'wp-plugins/buddypress/dev', 'wp-plugins/buddypress/dev', 9),
        ('https://translate.wordpress.org/projects/wp-plugins/buddypress/dev-readme/tr/default/', 'plugin', 'wp-plugins/buddypress/dev-readme', 'wp-plugins/buddypress/dev-readme', 10),
        ('https://translate.wordpress.org/projects/wp-plugins/bbpress/dev/tr/default/', 'plugin', 'wp-plugins/bbpress/dev', 'wp-plugins/bbpress/dev', 11),
        ('https://translate.wordpress.org/projects/wp-plugins/bbpress/dev-readme/tr/default/', 'plugin', 'wp-plugins/bbpress/dev-readme', 'wp-plugins/bbpress/dev-readme', 12),
        ('https://translate.wordpress.org/projects/wp-plugins/glotpress/dev/tr/default/', 'plugin', 'wp-plugins/glotpress/dev', 'wp-plugins/glotpress/dev', 13),
        ('https://translate.wordpress.org/projects/wp-plugins/glotpress/dev-readme/tr/default/', 'plugin', 'wp-plugins/glotpress/dev-readme', 'wp-plugins/glotpress/dev-readme', 14),
        ('https://translate.wordpress.org/projects/wp-plugins/loco-translate/dev/tr/default/', 'plugin', 'wp-plugins/loco-translate/dev', 'wp-plugins/loco-translate/dev', 15),
        ('https://translate.wordpress.org/projects/wp-plugins/loco-translate/dev-readme/tr/default/', 'plugin', 'wp-plugins/loco-translate/dev-readme', 'wp-plugins/loco-translate/dev-readme', 16),
        ('https://translate.wordpress.org/projects/wp-plugins/wordpress-seo/dev/tr/default/', 'plugin', 'wp-plugins/wordpress-seo/dev', 'wp-plugins/wordpress-seo/dev', 17),
        ('https://translate.wordpress.org/projects/wp-plugins/wordpress-seo/dev-readme/tr/default/', 'plugin', 'wp-plugins/wordpress-seo/dev-readme', 'wp-plugins/wordpress-seo/dev-readme', 18),
        ('https://translate.wordpress.org/projects/wp-plugins/advanced-custom-fields/dev/tr/default/', 'plugin', 'wp-plugins/advanced-custom-fields/dev', 'wp-plugins/advanced-custom-fields/dev', 19),
        ('https://translate.wordpress.org/projects/wp-plugins/advanced-custom-fields/dev-readme/tr/default/', 'plugin', 'wp-plugins/advanced-custom-fields/dev-readme', 'wp-plugins/advanced-custom-fields/dev-readme', 20),
        ('https://translate.wordpress.org/projects/wp-plugins/contact-form-7/dev/tr/default/', 'plugin', 'wp-plugins/contact-form-7/dev', 'wp-plugins/contact-form-7/dev', 21),
        ('https://translate.wordpress.org/projects/wp-plugins/contact-form-7/dev-readme/tr/default/', 'plugin', 'wp-plugins/contact-form-7/dev-readme', 'wp-plugins/contact-form-7/dev-readme', 22),
        ('https://translate.wordpress.org/projects/wp-themes/twentytwentyone/tr/default/', 'theme', 'wp-themes/twentytwentyone', 'wp-themes/twentytwentyone', 23),
        ('https://translate.wordpress.org/projects/apps/android/dev/tr/default/', 'apps', 'apps/android/dev', 'apps/android/dev', 24),
        ('https://translate.wordpress.org/projects/apps/android/release-notes/tr/default/', 'apps', 'apps/android/release-notes', 'apps/android/release-notes', 25),
        ('https://translate.wordpress.org/projects/apps/ios/dev/tr/default/', 'apps', 'apps/ios/dev', 'apps/ios/dev', 26),
        ('https://translate.wordpress.org/projects/apps/ios/release-notes/tr/default/', 'apps', 'apps/ios/release-notes', 'apps/ios/release-notes', 27),
        ('https://translate.wordpress.org/projects/meta/wordpress-org/tr/default/', 'meta', 'meta/wordpress-org', 'meta/wordpress-org', 28),
        ('https://translate.wordpress.org/projects/meta/rosetta/tr/default/', 'meta', 'meta/rosetta', 'meta/rosetta', 29),
        ('https://translate.wordpress.org/projects/meta/themes/tr/default/', 'meta', 'meta/themes', 'meta/themes', 30),
        ('https://translate.wordpress.org/projects/meta/plugins-v3/tr/default/', 'meta', 'meta/plugins-v3', 'meta/plugins-v3', 31),
        ('https://translate.wordpress.org/projects/meta/pattern-directory/tr/default/', 'meta', 'meta/pattern-directory', 'meta/pattern-directory', 32),
        ('https://translate.wordpress.org/projects/meta/forums/tr/default/', 'meta', 'meta/forums', 'meta/forums', 33),
        ('https://translate.wordpress.org/projects/meta/learn-wordpress/tr/default/', 'meta', 'meta/learn-wordpress', 'meta/learn-wordpress', 34),
        ('https://translate.wordpress.org/projects/meta/get-involved/tr/default/', 'meta', 'meta/get-involved', 'meta/get-involved', 35),
        ('https://translate.wordpress.org/projects/meta/wordcamp/tr/default/', 'meta', 'meta/wordcamp', 'meta/wordcamp', 36),
        ('https://translate.wordpress.org/projects/meta/openverse/tr/default/', 'meta', 'meta/openverse', 'meta/openverse', 37),
        ('https://translate.wordpress.org/projects/meta/browsehappy/tr/default/', 'meta', 'meta/browsehappy', 'meta/browsehappy', 38),
        ('https://translate.wordpress.org/projects/meta/o2/tr/default/', 'meta', 'meta/o2', 'meta/o2', 39),
        ('https://translate.wordpress.org/projects/meta/p2-breathe/tr/default/', 'meta', 'meta/p2-breathe', 'meta/p2-breathe', 40),
        ('https://translate.wordpress.org/projects/meta/wp20/tr/default/', 'meta', 'meta/wp20', 'meta/wp20', 41);

      INSERT OR IGNORE INTO trusted_source_tags (trusted_source_id, tag_id)
      SELECT s.id, (SELECT id FROM tags WHERE name = 'wordpress') FROM trusted_sources s;
    `,
  },
  {
    version: 6,
    // The general guide: TDK's spelling rules reduced to decisions a translator
    // applies, plus the WordPress title-case rule that costs the most. It goes
    // into every translation request (D34) and is the main lever for
    // consistency that a term glossary cannot express.
    get sql() {
      const body = styleGuide().replace(/'/g, "''");
      return body
        ? `INSERT INTO style_rules (tag_id, body) VALUES (NULL, '${body}');`
        : 'SELECT 1;';
    },
  },
  {
    version: 7,
    // Frozen history. Merged the rows that differed only by context and agreed
    // on the translation; migration 8 subsumes it by dropping context from the
    // key altogether. Kept verbatim so a database created before 8 and one
    // created after end up identical rather than merely similar.
    sql: `
  CREATE TEMP TABLE mem AS
    SELECT id, source_hash, tag_id, msgctxt, translation,
           ifnull(translation_plural, '') AS tp
      FROM glossary_entries WHERE pos IS NULL;
  CREATE INDEX temp.idx_mem ON mem (source_hash, tag_id);

  CREATE TEMP TABLE merge_map AS
  WITH grp AS (
    SELECT source_hash, tag_id,
           count(DISTINCT translation || char(31) || tp) AS variants,
           -- An existing context-less row is the natural survivor: keeping it
           -- means no surviving row has to change its key.
           min(CASE WHEN msgctxt IS NULL THEN id END) AS ctxless_id,
           min(id) AS any_id
      FROM mem
     GROUP BY source_hash, tag_id
    HAVING count(*) > 1 AND variants = 1)
  SELECT m.id AS drop_id, coalesce(g.ctxless_id, g.any_id) AS keep_id
    FROM grp g
    JOIN mem m ON m.source_hash = g.source_hash AND m.tag_id = g.tag_id
   WHERE m.id <> coalesce(g.ctxless_id, g.any_id);

  CREATE INDEX temp.idx_map ON merge_map (drop_id);

  -- Vouches first: a vouch is what keeps an entry alive (R14), and the
  -- CASCADE on the delete below would otherwise take them with the row. Two
  -- merged rows can carry the same source, so the survivor keeps the later
  -- sighting; an older one would look stale to the next sweep.
  INSERT INTO glossary_entry_sources (entry_id, trusted_source_id, translation, last_seen_sync_id)
  SELECT p.keep_id, s.trusted_source_id, s.translation, s.last_seen_sync_id
    FROM glossary_entry_sources s
    JOIN merge_map p ON p.drop_id = s.entry_id
   WHERE true
  ON CONFLICT (entry_id, trusted_source_id) DO UPDATE SET
    last_seen_sync_id = max(excluded.last_seen_sync_id,
                            glossary_entry_sources.last_seen_sync_id);

  -- A unit filled from a row that is about to go keeps its provenance.
  UPDATE translation_units
     SET glossary_entry_id = (SELECT keep_id FROM merge_map WHERE drop_id = glossary_entry_id)
   WHERE glossary_entry_id IN (SELECT drop_id FROM merge_map);

  DELETE FROM glossary_entries WHERE id IN (SELECT drop_id FROM merge_map);

  UPDATE glossary_entries SET msgctxt = NULL, updated_at = datetime('now')
   WHERE msgctxt IS NOT NULL AND id IN (SELECT keep_id FROM merge_map);

  DROP TABLE temp.merge_map;
  DROP TABLE temp.mem;`,
  },
  {
    version: 8,
    // The glossary is keyed on what it is for: a source and a translation.
    //
    // Context was part of the key, which made one string arrive many times over
    // — `About` held twelve rows, eleven of them `Hakkında`. Worse, the
    // precision it bought was imaginary: measured over three real plugins, the
    // context of a stored entry decided *none* of the 281 matches it could have
    // (R29). Those contexts are the source project's own keys — `navigation.
    // about`, `jetpackStats.button.cancel` — and they do not recur elsewhere.
    //
    // So context stops being a key and becomes what it always was in practice:
    // a note about where a translation has been seen. Several translations of
    // one string now sit side by side as the alternatives they are, and
    // matching ranks them (D44).
    sql: `
      DROP INDEX idx_glossary_memory_key;

      CREATE TABLE glossary_entry_contexts (
        entry_id INTEGER NOT NULL REFERENCES glossary_entries(id) ON DELETE CASCADE,
        msgctxt  TEXT NOT NULL,
        PRIMARY KEY (entry_id, msgctxt)
      ) STRICT, WITHOUT ROWID;

      CREATE TEMP TABLE keeper AS
      SELECT id, msgctxt,
             min(id) OVER (PARTITION BY source_hash, tag_id, translation,
                                        ifnull(translation_plural, '')) AS keep_id
        FROM glossary_entries WHERE pos IS NULL;
      CREATE INDEX temp.idx_keeper ON keeper (id);

      INSERT OR IGNORE INTO glossary_entry_contexts (entry_id, msgctxt)
      SELECT keep_id, msgctxt FROM keeper WHERE msgctxt IS NOT NULL;

      CREATE TEMP TABLE merge_map AS
        SELECT id AS drop_id, keep_id FROM keeper WHERE id <> keep_id;
      CREATE INDEX temp.idx_map ON merge_map (drop_id);

      -- Vouches move before the rows go, or ON DELETE CASCADE takes them (R14).
      INSERT INTO glossary_entry_sources (entry_id, trusted_source_id, translation, last_seen_sync_id)
      SELECT p.keep_id, s.trusted_source_id, s.translation, s.last_seen_sync_id
        FROM glossary_entry_sources s
        JOIN merge_map p ON p.drop_id = s.entry_id
       WHERE true
      ON CONFLICT (entry_id, trusted_source_id) DO UPDATE SET
        last_seen_sync_id = max(excluded.last_seen_sync_id,
                                glossary_entry_sources.last_seen_sync_id);

      UPDATE translation_units
         SET glossary_entry_id = (SELECT keep_id FROM merge_map WHERE drop_id = glossary_entry_id)
       WHERE glossary_entry_id IN (SELECT drop_id FROM merge_map);

      DELETE FROM glossary_entries WHERE id IN (SELECT drop_id FROM merge_map);
      UPDATE glossary_entries SET msgctxt = NULL WHERE pos IS NULL AND msgctxt IS NOT NULL;

      CREATE UNIQUE INDEX idx_glossary_memory_key
        ON glossary_entries (source_hash, translation, ifnull(translation_plural, ''), tag_id)
        WHERE pos IS NULL;

      DROP TABLE temp.merge_map;
      DROP TABLE temp.keeper;
    `,
  },
];

export const latestVersion = migrations[migrations.length - 1]!.version;
