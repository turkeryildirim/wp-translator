# 02 — Architecture

How the system described in [`01-business-logic.md`](01-business-logic.md) is built. Constraints R1–R14 and the decision register are in [`00-process.md`](00-process.md).

---

## Technology stack

**Node + TypeScript + SQLite** — [`adr/0001-tech-stack.md`](adr/0001-tech-stack.md). PO handling uses `gettext-parser`, the only library measured to round-trip a real export without loss; storage is SQLite through `better-sqlite3`, synchronous because a single-user local tool has no reason to be otherwise.

---

## AI provider

A **`TranslationProvider`** interface with one implementation: **opencode** — [`adr/0002-ai-provider.md`](adr/0002-ai-provider.md). It takes a batch of source strings plus the assembled context bundle and returns translations keyed back to their units. Which model answers is opencode's configuration, not this codebase's.

---

## Data model

Keyed so that the business rules are enforced by the database rather than by remembering to check.

**The glossary is keyed by `(source, msgctxt, tag)`.** The tag separates domains — `Add to cart` under `ecommerce` against the same string elsewhere (D5). `msgctxt` separates senses inside a single project: WordPress core translates `May` as `May` under `May abbreviation` and as `Mayıs` otherwise. Without it in the key those rows collapse and one arbitrary translation wins (R9).

Matching prefers the unit's own `msgctxt` and falls back to the context-less row. A unit **without** context matches only context-less entries — falling back to an arbitrary context-bearing one is precisely the collapse this key exists to prevent.

The unique index makes a collision impossible to introduce silently; it surfaces as a constraint violation, which is what drives the D29 choice dialogue.

`source_hash` is `sha256(source_text \x1f source_plural)`. Indexing the hash rather than the text keeps the key compact; WooCommerce strings run to several hundred characters.

**Several trusted sources vouch for the same string.** `Save`, `Cancel` and `Delete` appear in core and in most plugins, so ownership cannot be a single column on the entry. `glossary_entry_sources` links an entry to every source that carries it, with that source's own translation.

The D17 delete therefore removes a **link**, not the entry: after a sync run, links from that source not touched by the run are dropped, and an entry disappears only when no link remains and the owner did not write it. The effective `translation` is then re-resolved from the surviving links: the value the most links carry wins, ties broken by `trusted_sources.rank` (D36). The result does not depend on the order the sources happened to sync in. Measured over five sources, 88 % of disagreements are two-way ties, so `rank` decides most of them (R15).

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
  rank           INTEGER NOT NULL DEFAULT 100,   -- lower wins when sources disagree
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
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE UNIQUE INDEX idx_glossary_key ON glossary_entries(source_hash, ifnull(msgctxt,''), tag_id);
CREATE INDEX idx_glossary_tag      ON glossary_entries(tag_id);
CREATE INDEX idx_glossary_search   ON glossary_entries(source_text);

-- Which trusted sources vouch for an entry, and with what translation.
-- Several sources carry the same string ('Save', 'Cancel'), so ownership
-- cannot be a single column: the sweep removes a LINK, and the entry goes
-- only when no link remains and the owner did not write it.
CREATE TABLE glossary_entry_sources (
  entry_id          INTEGER NOT NULL REFERENCES glossary_entries(id)  ON DELETE CASCADE,
  trusted_source_id INTEGER NOT NULL REFERENCES trusted_sources(id)   ON DELETE CASCADE,
  translation       TEXT NOT NULL,
  last_seen_sync_id INTEGER NOT NULL,
  PRIMARY KEY (entry_id, trusted_source_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_ges_sweep ON glossary_entry_sources(trusted_source_id, last_seen_sync_id);

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

Loading WooCommerce and WordPress core together gives 50 615 entries over 51 258 links, of which **643 are vouched for by both sources**. A single owner column would delete or strand every one of those. Sweeping WooCommerce out takes 452 ms and leaves core's 8 142 entries intact.

`idx_unit_glossary` exists only because SQLite does not index foreign keys automatically — without it, every glossary delete scans `translation_units` in full. The query plan confirms it is gone.

Raw exported PO files are kept on disk as well as imported; `po_path` and `sync_runs.po_path` record where.

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

**Exact byte match on the source string. No normalisation.**

This was measured, not assumed. Across WooCommerce's 14 159 distinct source strings, each candidate normalisation was applied and the resulting merges checked against the translations they would unify:

| Normalisation | Extra matches gained | …that map to **different** translations |
|---|---:|---:|
| Collapse whitespace | 6 | 5 |
| + lowercase | 253 | **197** |
| + strip trailing punctuation | 484 | **431** |

Almost everything normalisation would gain is a string whose translation genuinely differs. `Saved for Later` is `Sonraya Kaydet` while `Saved for later` is `Sonraya kaydedildi`; `No items found` and `No items found.` have different translations. Case-folding these applies the wrong translation and no quality check catches it, because nothing is malformed.

Whitespace is also meaningful in PO — a trailing space before a value is usually deliberate.

So the rule is the strict one: byte-identical source, byte-identical `msgid_plural`. Anything else goes to the AI, which is the safe direction to fail.

**Lookup order** for a unit with context `C` in a project tagged `T₁…Tₙ`:

1. `(source, C, T)` for each project tag
2. `(source, '', T)` for each project tag
3. no match — the unit goes to the AI

When several of a project's tags match with **different** translations, nothing is auto-filled (D37): the unit is left `untranslated` in the pipeline, marked `review`, and the panel resolves the candidates at display time by re-querying the glossary. No extra table — the candidates are derivable from `(source_hash, msgctxt, project tags)` whenever they are needed.

---

## Usage-surface detection

Measured against real plugin sources, path patterns alone are weaker than they look:

| Project | strings | decided by path alone |
|---|---:|---:|
| WooCommerce | 14 523 | 60.9 % |
| Contact Form 7 | 442 | 36.4 % |
| Yoast SEO | 2 606 | 20.4 % |

Adding file-content signals (`add_menu_page`, `add_meta_box`, `WP_List_Table`, `is_admin()` against `add_shortcode`, `wc_get_template`, `register_block_type`, `WP_Widget`) lifts WooCommerce to 66.6 %. A third still cannot be decided.

**Classification is per file, not per string.** WooCommerce's 14 523 strings reference only 1 649 distinct files — 15.2 strings per file — and scanning all of them takes 0.7 s. Classify each file once, cache it, and every string in it inherits the answer.

`unknown` is a legitimate outcome. The surface is context for the AI, not a correctness gate, so a string with no confident classification simply gets less context. Guessing would be worse than admitting ignorance.

98 % of referenced files are present in the release ZIP, consistent with the `dev`-versus-release gap recorded in R7.

**Source excerpts must be capped.** For strings the heuristics cannot place, the natural fallback is to show the AI the code around the reference. Measured on WooCommerce, an uncapped ±6-line window has a median of 601 characters but a p90 of **65 425** — because 14 % of referenced files are minified bundles, one carrying a single line of 1.73 million characters, and **31 % of all references point into them**.

Capping each line at 300 characters and the whole excerpt at 2 000 brings this to a median of 134 tokens, p90 437, hard maximum 500. A file whose longest line exceeds 2 000 characters is treated as minified and yields no excerpt at all — a 300-character slice of a bundle is noise, not context.

---

## AI pipeline

**Context bundle**, assembled per batch:

- fixed: the general style guide, plus per-tag rules for the project's tags, plus project metadata and readme (≈1 400 tokens)
- per string: source text, `msgctxt`, `#.` comment, derived surface or a capped source excerpt (≈250 tokens median)
- glossary terms relevant to the batch

Measured against **capped** excerpt sizes (R12), that puts a **50-string batch at roughly 17 600 input tokens** and a 100-string batch at 34 000. Batch size is a setting; 50 is the starting point, small enough that a failure re-runs cheaply and large enough that the fixed portion is amortised.

**Identity across the round trip.** Strings are sent with opaque ids and matched back by id, never by position or by the source text — a provider that reorders, merges or subtly rewrites a source string must not be able to silently misalign translations. Any id in the response that was not sent, or any sent id missing from the response, fails the batch rather than being guessed at.

**Validation before storage.** Every returned translation runs the D9 quality checks before it is written. Output lands in `review` regardless of provider (D22).

**Failure handling.** A batch is the retry unit. Partial results from a failed batch are discarded rather than half-stored, so a re-run is idempotent. Translation is resumable: the job records which units it has covered, and re-running picks up the untranslated remainder — necessary because WooCommerce at 50 strings per batch is roughly 290 requests.

**Cost.** opencode reports `cost` in USD and `tokens` (input, output, reasoning, cache) on every assistant message, so per-batch cost is read back rather than estimated, and aggregates per project.

**Running under opencode.** Translation uses a dedicated opencode agent with tools disabled. An unconstrained agent can attempt a tool call, which raises a permission request that nothing will answer, and the batch hangs. Startup verifies the service is reachable and at least one model is configured before any project can be translated.

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

- **Database:** one SQLite file, WAL mode. The glossary and the per-project stores are tables in that one database, not separate files — matching reads the glossary while writing units, and a single file keeps that in one transaction and one backup.
- **On disk beside it:** raw exported PO files (`po_path`, `sync_runs.po_path`) and unpacked source trees (`source_path`). These are re-downloadable, so they are cache, not state.
- **Backup** covers the database file only. It is the one thing that is expensive to rebuild: trusted-source rows can be re-synced, but the owner's own approvals cannot be recovered from anywhere.
- **Credentials** are per provider, stored locally outside the database so a copied or shared database carries no keys.
- **Migrations** run forward-only on start, versioned in the file via `PRAGMA user_version`.

**Tag normalisation** happens in the application, not the collation: SQLite's `NOCASE` folds ASCII only, so `içerik` and `İÇERİK` compare unequal (R10). Tag names are trimmed and case-folded with Turkish rules before insert. The `NOCASE` collation stays as a second line of defence.

**Tag merge** (D33) rewrites `glossary_entries.tag_id` from the losing tag to the winning one. Where both tags hold the same `(source, msgctxt)` the unique index rejects the update, which is the interesting case: it is the same collision as D29 and takes the same two-way choice from the owner. Rows that do not collide move silently.

**Glossary search.** `idx_glossary_search` on `source_text` serves equality and prefix lookups. Substring search across tens of thousands of rows needs an FTS5 virtual table mirroring `source_text` and `translation`; whether the panel needs that is a Phase 3 question, and adding it later requires no change to the tables above.
