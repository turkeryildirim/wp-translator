# 02 — Architecture

How the system described in [`01-business-logic.md`](01-business-logic.md) is built. Constraints R1–R5 and the decision register are in [`00-process.md`](00-process.md).

This document is filled in Phase 2. Sections below state what is already settled and what remains to be decided.

---

## Technology stack

**Node + TypeScript + SQLite** — [`adr/0001-tech-stack.md`](adr/0001-tech-stack.md). PO handling uses `gettext-parser`, the only library measured to round-trip a real export without loss; storage is SQLite through `better-sqlite3`, synchronous because a single-user local tool has no reason to be otherwise.

---

## AI provider

A pluggable **`TranslationProvider`** interface — [`adr/0002-ai-provider.md`](adr/0002-ai-provider.md). It takes a batch of source strings plus the assembled context bundle and returns translations keyed back to their units. The concrete roster is supplied by the owner; nothing else in the design waits on it.

---

## Data model

Keyed so that the business rules are enforced by the database rather than by remembering to check.

**The glossary is keyed by `(source, msgctxt, tag)`.** The tag separates domains — `Add to cart` under `ecommerce` against the same string elsewhere (D5). `msgctxt` separates senses inside a single project: WordPress core translates `May` as `May` under `May abbreviation` and as `Mayıs` otherwise. Without it in the key those rows collapse and one arbitrary translation wins (R9).

Matching prefers the unit's own `msgctxt` and falls back to the context-less row. A unit **without** context matches only context-less entries — falling back to an arbitrary context-bearing one is precisely the collapse this key exists to prevent.

The unique index makes a collision impossible to introduce silently; it surfaces as a constraint violation, which is what drives the D29 choice dialogue.

`source_hash` is `sha256(source_text \x1f source_plural)`. Indexing the hash rather than the text keeps the key compact; WooCommerce strings run to several hundred characters.

`last_seen_sync_id` implements the D17 delete: after a sync run completes, any row from that source not touched by the run is gone.

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ---------- vocabulary ----------
CREATE TABLE tags (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

-- ---------- trusted sources (Workflow A) ----------
CREATE TABLE trusted_sources (
  id             INTEGER PRIMARY KEY,
  translate_url  TEXT NOT NULL UNIQUE,
  family         TEXT NOT NULL CHECK (family IN ('plugin','theme','core','apps','meta','patterns')),
  project_path   TEXT NOT NULL,
  label          TEXT,
  last_sync_id   INTEGER,
  last_synced_at TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE TABLE sync_runs (
  id                INTEGER PRIMARY KEY,
  trusted_source_id INTEGER NOT NULL REFERENCES trusted_sources(id) ON DELETE CASCADE,
  started_at        TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at       TEXT,
  po_path           TEXT,
  status            TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','ok','failed')),
  error             TEXT,
  entries_seen      INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX idx_sync_runs_source ON sync_runs(trusted_source_id, started_at);

-- ---------- glossary / translation memory ----------
-- Keyed by (source, msgctxt, tag). The tag separates domains; msgctxt
-- separates senses inside one project ("May" the abbreviation from
-- "May" the month). Matching prefers the unit's own msgctxt and falls
-- back to the context-less row.
CREATE TABLE glossary_entries (
  id                 INTEGER PRIMARY KEY,
  source_hash        TEXT NOT NULL,          -- sha256 of source_text || 0x1f || coalesce(source_plural,'')
  source_text        TEXT NOT NULL,
  source_plural      TEXT,
  msgctxt            TEXT,
  tag_id             INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  translation        TEXT NOT NULL,
  translation_plural TEXT,
  origin             TEXT NOT NULL CHECK (origin IN ('trusted','owner')),
  trusted_source_id  INTEGER REFERENCES trusted_sources(id) ON DELETE SET NULL,
  last_seen_sync_id  INTEGER,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE UNIQUE INDEX idx_glossary_key ON glossary_entries(source_hash, ifnull(msgctxt,''), tag_id);
CREATE INDEX idx_glossary_tag      ON glossary_entries(tag_id);
CREATE INDEX idx_glossary_sweep    ON glossary_entries(trusted_source_id, last_seen_sync_id);
CREATE INDEX idx_glossary_search   ON glossary_entries(source_text);

-- ---------- projects (Workflow B) ----------
CREATE TABLE projects (
  id            INTEGER PRIMARY KEY,
  family        TEXT NOT NULL CHECK (family IN ('plugin','theme','core','apps','meta','patterns')),
  project_path  TEXT NOT NULL,              -- e.g. wp-plugins/woocommerce
  sub_project   TEXT,                       -- dev | stable | NULL for flat families
  translate_url TEXT NOT NULL UNIQUE,
  slug          TEXT,                       -- plugins/themes only
  name          TEXT,
  version       TEXT,
  description   TEXT,
  readme        TEXT,
  source_path   TEXT,                       -- unpacked ZIP on disk, plugins/themes only
  po_path       TEXT,                       -- raw export retained on disk
  imported_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE TABLE project_tags (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id)     ON DELETE CASCADE,
  PRIMARY KEY (project_id, tag_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_project_tags_tag ON project_tags(tag_id);

-- ---------- translation units ----------
CREATE TABLE translation_units (
  id                 INTEGER PRIMARY KEY,
  project_id         INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ordinal            INTEGER NOT NULL,       -- position in the source export
  source_hash        TEXT NOT NULL,
  msgid              TEXT NOT NULL,
  msgid_plural       TEXT,
  msgctxt            TEXT,                   -- carried verbatim, never matched (D24)
  refs               TEXT,                   -- '#:' block, verbatim
  extracted_comments TEXT,                   -- '#.' block, verbatim
  msgstr             TEXT,
  msgstr_plural      TEXT,
  state              TEXT NOT NULL DEFAULT 'untranslated'
                     CHECK (state IN ('untranslated','review','ok')),
  provenance         TEXT CHECK (provenance IN ('glossary','ai','human')),
  provider           TEXT,                   -- which TranslationProvider produced it
  glossary_entry_id  INTEGER REFERENCES glossary_entries(id) ON DELETE SET NULL,
  usage_surface      TEXT CHECK (usage_surface IN ('admin','frontend','both','unknown')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE UNIQUE INDEX idx_unit_identity ON translation_units(project_id, source_hash, ifnull(msgctxt,''));
CREATE INDEX idx_unit_review  ON translation_units(project_id, state);
CREATE INDEX idx_unit_lookup  ON translation_units(source_hash);
CREATE INDEX idx_unit_glossary ON translation_units(glossary_entry_id);  -- FK; without it every glossary delete scans this table

-- ---------- style guide ----------
CREATE TABLE style_rules (
  id         INTEGER PRIMARY KEY,
  tag_id     INTEGER UNIQUE REFERENCES tags(id) ON DELETE CASCADE,  -- NULL row = general guide
  body       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;
CREATE UNIQUE INDEX idx_style_general ON style_rules((tag_id IS NULL)) WHERE tag_id IS NULL;

-- ---------- quality-check exceptions ----------
CREATE TABLE qa_exceptions (
  id         INTEGER PRIMARY KEY,
  unit_id    INTEGER NOT NULL REFERENCES translation_units(id) ON DELETE CASCADE,
  rule       TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (unit_id, rule)
) STRICT;
```

**Measured on the real WooCommerce export**, 14 530 translated strings × 3 tags:

| | |
|---|---|
| Rows | 43 116 |
| Write (batched upsert) | 0.39 s |
| Database size | 16.1 MB |
| Match query plan | `SEARCH USING INDEX idx_glossary_key (source_hash=? AND <expr>=? AND tag_id=?)` |
| 5 000 real lookups, with fallback | 92 ms |
| Sync sweep plan | `SEARCH USING INDEX idx_glossary_sweep` |

Matching a whole project is not a performance concern: under 0.02 ms per lookup, even with the two-step fallback, means WooCommerce resolves in well under a second.

Loading WordPress core `dev` under the revised key stores 8 142 of 8 142 rows — no collapse — and `May` survives as three rows: no context and `genitive` both `Mayıs`, `May abbreviation` as `May`.

`idx_unit_glossary` exists only because SQLite does not index foreign keys automatically — without it, every glossary delete scans `translation_units` in full. The query plan confirms it is gone.

Raw exported PO files are kept on disk as well as imported; `po_path` and `sync_runs.po_path` record where.

**Open:** tag names need Turkish-aware case folding in the application; the `NOCASE` collation only folds ASCII (R10).

**Open:** `idx_glossary_search` on `source_text` serves prefix and equality search but not `LIKE '%…%'`. If the glossary browser needs substring search across tens of thousands of rows, that is an FTS5 virtual table, not this index.

**Open:** whether tag merge (D33) rewrites `glossary_entries.tag_id` in place, which can collide with the unique index when both tags hold the same source string. The collision is the interesting case — it needs the same two-way choice as D29.

---

## PO import and export

Settled by R1–R3 and the export rules in `01`:

- Import PO, never JSON/Jed.
- Preserve `#:`, `#.`, plural forms and headers. **Entry order is not a requirement** — GlotPress matches an imported entry by singular + plural + context, not by position.
- Export only `ok` strings; never emit `#, fuzzy`, an empty `msgstr`, or a `#~` obsolete entry — GlotPress mis-flags or silently drops all three on import.

- Preserve `msgctxt` verbatim (D24). It is never read for matching, so it can be treated as an opaque column that travels with the unit.

Library fidelity was measured against the 14 531-entry WooCommerce export — see `adr/0001-tech-stack.md`. Node's `gettext-parser` round-trips it without loss; the leading PHP and Go libraries each lose data silently. Whether an off-the-shelf library is used or the parser is written by hand follows from ADR-0001.

---

## translate.wordpress.org and wordpress.org integration

Verified (R5, R5b, R6, R8): the export endpoint is a public GET returning a PO body, `filters[status]` works, and no rate-limit headers are advertised. For plugins and themes the info API returns name, version, `download_link`, tags and readme sections, so nothing needs scraping — but the project must first be identified from its URL, since the slug alone does not locate it.

Setting up a plugin or theme therefore makes three public, unauthenticated calls: info API, versioned ZIP, PO export. Other families have only the third.

Still to settle:

- **Sub-project probing.** D27 probes the `dev` export URL and falls back to `stable` on 404. Per R5b this must be a status-code check: a 404 returns a large HTML body, so a byte-count or "response received" test would silently store an error page as a PO file. Themes take a different URL shape with no sub-project segment at all.
- Actual request pacing. No rate limit is advertised, which is not the same as none existing; the trusted-source Update loop issues one request per project and should be deliberately paced and resumable.
- Fetching wordpress.org metadata and `readme.txt` for tag proposal and AI context — **available only for `wp-plugins` and `wp-themes`** (R8).
- **URL parsing.** The URL is the project's identity (D31), so the system must resolve both `…/projects/<path>/tr/default/` and `…/locale/tr/default/<type>/<slug>/` into a family, slug and sub-project. Shapes differ per family (D32): themes have no sub-project, `wp` nests two levels, `apps` splits by platform. The metadata and source steps must be skipped, not failed, for the four families that have neither.

---

## Matching engine

Exact match on source string, scoped by the project's domain tags.

**Open:** what normalisation is applied before comparison (whitespace, case, trailing punctuation) and whether it risks false matches; the fallback order when a project has several tags, or when no entry exists under any of them; behaviour when several glossary candidates tie.

---

## Usage-surface detection

Deriving whether a string appears in the admin or the front end, from `#:` paths, `#.` comments and the stored source code. A string can legitimately be both.

**Open:** the heuristics themselves, and how they are validated against real plugins.

---

## AI pipeline

**Open:** context bundle assembly and its token budget; batching and how string identity survives the round trip; structured output and validation before storage; automatic quality checks on AI output; retry, partial failure, resumability; cost reporting.

---

## Testing strategy

Scope is deliberately narrow (D30): verify **the exported PO**, nothing further. No WordPress installation, no plugin activation, no check that the catalogue loads at runtime.

Two things to verify:

1. **Syntactic validity.** `msgfmt --check` from GNU gettext validates PO syntax and, with `--check-format`, that `printf` placeholders agree between source and translation. The CLI is not currently installed (`dnf install gettext`); PHP's `gettext` extension is a different thing and does not provide it. If an external binary is unwanted, the equivalent checks can be asserted directly.
2. **GlotPress will import it.** Expressed as assertions over the output rather than by running GlotPress: only `ok` strings present, no `#, fuzzy`, no empty `msgstr`, no `#~`, every `msgctxt` preserved, plural arity intact.

Offline fixtures: `~/Projects/investakademi/app/languages/` holds WP core `tr_TR` files with `msgctxt` and plural forms, `~/Projects/wc-sanal-pos/languages/` holds one with neither.

**Open:** whether to depend on the `msgfmt` binary or assert the same rules in code.

---

## Storage, configuration and runtime

**Open:** database engine and file location; AI API key storage; how the tool starts; backup of the glossary, which is the most valuable asset in the system and the only part that is expensive to rebuild; schema migration.
