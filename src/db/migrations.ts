import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Migration {
  version: number;
  sql: string;
}

const initialSchema = (): string =>
  readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf-8');

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
];

export const latestVersion = migrations[migrations.length - 1]!.version;
