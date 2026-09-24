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
  msgctxt            TEXT,                   -- carried verbatim, never matched
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
