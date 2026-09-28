import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Migration {
  version: number;
  sql: string;
}

const initialSchema = (): string =>
  readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf-8');

/**
 * The seeded Turkish style guide, read from `style-guide/tr-genel.md` so that
 * file stays the single copy. Seeded once, on first open, so later edits in the
 * panel are never overwritten.
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
 * Forward-only, applied in order, each in a transaction with `PRAGMA
 * user_version` moved to match. `schema.sql` is version 1 and is never edited
 * again, so every database ends up identical rather than merely similar.
 */
export const migrations: readonly Migration[] = [
  { version: 1, get sql() { return initialSchema(); } },
  {
    version: 2,
    // The official glossary distinguishes terms by part of speech — `archive`
    // is `arşiv` as a noun and `arşivle` as a verb. It cannot live in `msgctxt`,
    // which is written verbatim into exported PO files.
    sql: `
      ALTER TABLE glossary_entries ADD COLUMN pos TEXT;
      ALTER TABLE glossary_entries ADD COLUMN note TEXT;

      -- Two invariants, not one, because the table now holds two kinds of row.
      --
      -- Translation memory (pos IS NULL): one translation per source, context
      -- and tag, so a second cannot be added silently.
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
    // The export carries the catalogue's own headers back out: Plural-Forms
    // decides how many msgstr slots an entry has, and Language names the locale.
    sql: `ALTER TABLE projects ADD COLUMN po_headers TEXT;`,
  },
  {
    version: 4,
    // Which tags a source writes into.
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
    // The owner's list, seeded so a fresh database is usable without adding
    // sources by hand: human-translated, reviewed over years and kept current.
    // All land under one `wordpress` tag; splitting them is the owner's call.
    //
    // Rank is the file order — core first, then the large plugins, then apps
    // and meta. It decides most disagreements, so the owner reorders it.
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
    // applies, plus WordPress's title-case rule. It goes into every translation
    // request and carries the consistency a term glossary cannot express.
    get sql() {
      const body = styleGuide().replace(/'/g, "''");
      return body
        ? `INSERT INTO style_rules (tag_id, body) VALUES (NULL, '${body}');`
        : 'SELECT 1;';
    },
  },
  {
    version: 7,
    // Superseded by migration 8, which drops context from the key altogether.
    // Kept verbatim so every database passes through the same states.
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

  -- Vouches first: they keep an entry alive, and the CASCADE below would take
  -- them with the row. The survivor keeps the later sighting.
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
    // Keys the glossary on what it is for: a source and a translation. Context
    // becomes a note of where a translation has been seen, so several
    // translations of one string sit side by side and matching ranks them.
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

      -- Vouches move before the rows go, or ON DELETE CASCADE takes them.
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
  {
    version: 9,
    // Gives the glossary browser's `readings` subquery an index to reach a
    // string's other translations by; without one it scans the whole table.
    sql: `CREATE INDEX idx_glossary_source ON glossary_entries (source_hash, tag_id);`,
  },
  {
    version: 10,
    // `upstream` records what the service had when the project came in, which
    // separates an approved string the owner has never seen from one they
    // settled themselves.
    // Only two values, because GlotPress states status through an export filter
    // rather than a flag in the PO; a fuzzy entry reaches us with an empty
    // translation and lands as untranslated.
    //
    // `blocked` is the quality-check result, stored so the review queue can
    // filter and page on it in SQL rather than checking every row.
    sql: `
      ALTER TABLE translation_units ADD COLUMN upstream TEXT
        CHECK (upstream IN ('current','untranslated'));
      ALTER TABLE translation_units ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0;
      UPDATE translation_units SET upstream = 'untranslated' WHERE upstream IS NULL;
      CREATE INDEX idx_unit_queue ON translation_units (project_id, state, blocked);
      CREATE INDEX idx_unit_upstream ON translation_units (project_id, upstream);
    `,
  },
  {
    version: 11,
    // What the model has already been asked, so the same question is not paid
    // for twice. A string like `Theme Description` turns up in project after
    // project; without this, each one buys the same answer again.
    //
    // The key is the exact bytes of the question, whitespace included. Folding
    // it would make a cached answer apply to a string it was never asked about,
    // and a trailing space is precisely the defect this tool hunts.
    //
    // `rules_hash` is the style guide the answer was given under, so editing the
    // guide retires the answers rather than reusing opinions formed under rules
    // that no longer hold.
    sql: `
      CREATE TABLE ai_memory (
        id          INTEGER PRIMARY KEY,
        kind        TEXT NOT NULL CHECK (kind IN ('translation','judgement')),
        key_hash    TEXT NOT NULL,
        rules_hash  TEXT NOT NULL,
        source_text TEXT NOT NULL,              -- verbatim, so the panel can read it
        question    TEXT NOT NULL,              -- JSON: exactly what was asked
        answer      TEXT NOT NULL,              -- JSON: exactly what came back
        model       TEXT,
        uses        INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        used_at     TEXT
      ) STRICT;

      CREATE UNIQUE INDEX idx_ai_memory_key ON ai_memory (kind, key_hash, rules_hash);
      CREATE INDEX idx_ai_memory_source ON ai_memory (source_text);
    `,
  },
  {
    version: 12,
    // A source is a project, not a URL. `translate_url` was the only unique
    // column, so the same project added by another spelling of its address —
    // without the locale segment, through the locale listing page, with a query
    // string — became a second row, synced twice and vouching for its own
    // entries twice.
    //
    // Duplicates are merged rather than deleted: `glossary_entry_sources` keys on
    // `trusted_source_id`, and dropping a row would take real vouches with it.
    // The lowest id survives, being the one the owner added first.
    sql: `
      CREATE TEMP TABLE keeper AS
        SELECT project_path, min(id) AS keep_id
          FROM trusted_sources GROUP BY project_path;

      UPDATE OR IGNORE glossary_entry_sources
         SET trusted_source_id = (
               SELECT keep_id FROM keeper k
                 JOIN trusted_sources s ON s.project_path = k.project_path
                WHERE s.id = glossary_entry_sources.trusted_source_id)
       WHERE trusted_source_id NOT IN (SELECT keep_id FROM keeper);

      INSERT OR IGNORE INTO trusted_source_tags (trusted_source_id, tag_id)
        SELECT k.keep_id, t.tag_id
          FROM trusted_source_tags t
          JOIN trusted_sources s ON s.id = t.trusted_source_id
          JOIN keeper k ON k.project_path = s.project_path
         WHERE t.trusted_source_id <> k.keep_id;

      DELETE FROM trusted_sources WHERE id NOT IN (SELECT keep_id FROM keeper);

      CREATE UNIQUE INDEX idx_trusted_source_path ON trusted_sources (project_path);

      DROP TABLE temp.keeper;
    `,
  },
  {
    version: 13,
    // A trusted source with no tag contributes nothing: `syncTrustedSource` loops
    // over its tags, so an empty list skips every unit and the run still reports
    // success. Sources added through the panel were created without any, so they
    // synced cleanly and imported zero entries.
    //
    // Repaired to the seeded tag, which is where everything starts before the
    // owner splits it.
    sql: `
      INSERT INTO trusted_source_tags (trusted_source_id, tag_id)
        SELECT s.id, (SELECT id FROM tags ORDER BY name = 'wordpress' DESC, id LIMIT 1)
          FROM trusted_sources s
         WHERE NOT EXISTS (SELECT 1 FROM trusted_source_tags t WHERE t.trusted_source_id = s.id)
           AND EXISTS (SELECT 1 FROM tags);
    `,
  },
];

export const latestVersion = migrations[migrations.length - 1]!.version;
