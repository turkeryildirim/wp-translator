# Working in this repository

This document serves as the architectural and design guide for AI agents and developers modifying this codebase.
Read `README.md` for user-facing features, installation, and general command usage.

---

## 1. Core Architecture & Build Constraints

### Source-Run Constraint
The server and CLI tools execute directly from source using `node --experimental-strip-types` without an intermediate compilation step.
* TypeScript syntax that emits runtime code is prohibited:
  * No constructor parameter properties (`constructor(private readonly x: T)`).
  * No `enum`, `namespace`, or decorators.
  * Internal module imports must retain the `.ts` extension (supported via `allowImportingTsExtensions` in `tsconfig.json`).
* Front-end and Electron builds are the only exceptions:
  * Frontend panel bundles via Vite (`root: 'panel'`, config in `vite.config.ts`).
  * Electron main process bundles via Vite SSR mode (`vite.electron.config.ts`).
  * Test suites run in Vitest under `vitest.config.ts`. Do not merge Vite configs.

### Process & Single-Instance Model
* Single-user, local-only daemon bound strictly to `127.0.0.1`.
* In Electron desktop mode, `app.requestSingleInstanceLock()` guards the process. If another instance exists, the secondary instance immediately invokes `process.exit(0)` after `app.quit()` to avoid contesting port 4173 or the database.
* The HTTP server attempts port 4173 by default and automatically falls back to an ephemeral port (`port: 0`) if port 4173 is occupied.

---

## 2. Database & Storage Architecture

### Database Engine & Migrations
* Database operations use `better-sqlite3` synchronously.
* Storage directory resolution (`src/db/path.ts`):
  * **Linux:** `~/.config/wp-translator/wp-translator.sqlite`
  * **Windows:** `%APPDATA%\wp-translator\wp-translator.sqlite`
  * **Development CLI:** Optional project-local directory via `preferLocal: true`.
* Schema changes are strictly forward-only in `src/db/migrations.ts` tracked by `PRAGMA user_version`. `schema.sql` represents version 1 and must never be edited retroactively.
* Inlined asset loading in migrations (`src/db/migrations.ts`) supports both `file://` URIs and `data:application/sql;base64` URLs emitted by Vite bundling.

### Automated Backups
* Implemented in `src/db/backup.ts`.
* On Electron application quit (`before-quit`), an online SQLite snapshot is written to `backups/wp-translator-YYYY-MM-DD_HH-mm-ss.sqlite`.
* Retention policy: Automatically purges older backup files, keeping only the most recent closing snapshots.

### Query Performance & Indexing
* `better-sqlite3` runs synchronously on the main event loop. Statements executed during HTTP requests must never trigger table scans.
* Paged table queries use Common Table Expressions (CTEs) to isolate target row IDs before computing joins or status aggregations.
* SQLite's `LIKE` and `NOCASE` fold ASCII only. Case-insensitive Turkish search is handled via the registered application function `fold` (`src/db/fold.ts`).

---

## 3. Application Screens & Module Responsibilities

The user interface is structured into dedicated screens managed in `panel/src/App.vue`:

### 1. Çeviri İnceleme (`review`) — `panel/src/ReviewTable.vue`
* Interactive workspace for project translation units.
* Filter views: `waiting`, `untranslated`, `blocked`, `upstream`, `translated`, `all`.
* Row detail inspection:
  * Visual markers for invisible/non-rendering whitespace characters (`src/text/whitespace.ts`).
  * Quality check violation reasons (`src/quality/`).
  * Reason-based quality check override (`overrideCheck` in `src/server/review.ts`).
* Find & Replace: Scope-aware, literal, and case-sensitive. Rewrites return modified rows to `review` state.
* Export: Generates clean, Gettext-compliant PO files containing only approved (`ok`) translations.

### 2. Kuyruk Tarayıcısı (`queue`) — `panel/src/QueueReview.vue` & `src/wporg/queueWorker.ts`
* Autonomous reviewer connecting directly to translate.wordpress.org queues.
* Uses the saved WordPress.org authentication cookie (`app_settings` table).
* Scans plugins and themes for pending (`waiting` / `fuzzy`) submissions (`src/wporg/scanner.ts`).
* Processes queue rows:
  1. Local glossary exact matching.
  2. Local quality checks evaluation.
  3. AI model judgement call (`src/server/judge.ts`).
* Execution modes: `dry_run` (simulation without writes) and `apply` (executes status changes on translate.wordpress.org).
* Detects GlotPress markup changes or missing action nonces and surfaces explicit error logs.

### 3. Sözlük (`glossary`) — `panel/src/GlossaryBrowser.vue`
* Manages translation memory rows (`glossary_entries` where `pos IS NULL`).
* Distinguishes owner entries (`origin = 'owner'`) from trusted source entries (`origin = 'source'`).
* Matches are ranked by source authority; human-approved upstream translations take precedence.

### 4. Terim Bankası (`tm`) — `panel/src/TranslationMemoryBrowser.vue`
* Manages terminology rows (`glossary_entries` where `pos IS NOT NULL`).
* Holds parts-of-speech definitions, notes, and official WordPress glossary terms (`is_official = 1`).

### 5. Güvenilir Projeler (`sources`) — `panel/src/TrustedSources.vue`
* Curated upstream project repository list (`trusted_sources` table).
* Priority ordering determines winning translations when projects disagree.
* Sync engine (`src/glossary/sync.ts`): Fetches upstream PO exports and synchronizes translation memory.

### 6. Etiketler & Üslup (`tags`) — `panel/src/TagsAndStyle.vue`
* Manages vocabulary tags (e.g., general WordPress vs. WooCommerce).
* Attaches free-text markdown style guides to tags; injected into AI prompts for contextual guidance.
* Tag merging tool with collision detection for overlapping terms.

### 7. Proje Ekle (`add`) — `panel/src/AddProject.vue`
* Imports new projects from translate.wordpress.org URLs.
* Retrieves project PO catalogues and scrapes WordPress.org plugin/theme metadata (`src/wporg/metadata.ts`).

### 8. Genel Ayarlar (`settings`) — `panel/src/Settings.vue`
* Configures AI CLI tools (`agy`, `opencode`, `claude`, `codex`) and active model identifiers (`src/db/aiSettings.ts`).
* Manages WordPress.org session cookies with live connection verification.

### 9. AI Hafızası (`ai_memory`) — `panel/src/AiMemory.vue` & `src/ai/memory.ts`
* Persistent cache of model translations and judgements indexed by content hash and style rules hash.
* Allows searching, filtering by kind, and deleting individual or bulk cache records.

### 10. Sistem Günlüğü (`logs`) — `panel/src/SystemLogs.vue` & `src/db/logs.ts`
* Central operational log table (`system_logs`) tracking errors, warnings, GlotPress UI drifts, and queue runs.
* Enforces automatic rolling retention, purging records older than 7 days.

---

## 4. AI Engine & CLI Integration Rules

* Supported CLI engines reside in `src/translate/` (`agy.ts`, `opencode.ts`, `claude.ts`, `codex.ts`).
* **No Automatic Provider Fallback:** When a model fails, times out, or exhausts quota, the operation must fail explicitly and record the error in `system_logs`. Automatic switching between providers is prohibited to prevent unexpected API costs.
* **Stdin Handling:** CLI spawn invocations must ignore stdin (`stdio: ['ignore', …]`) to prevent commands like `opencode` from hanging indefinitely.
* **Tool Call Refusal:** Prompts must enforce `NO_TOOLS` to prevent models from attempting shell or filesystem commands during batch translation turns.
* **Escaped Quote Repair:** Language models occasionally echo JSON string escaping (`\"`). `src/text/escapes.ts` sanitizes these responses before quality checks run.

---

## 5. Desktop & Native Packaging

* Electron packaging uses Electron 42 (ABI 146) to match precompiled `better-sqlite3` native binaries.
* `scripts/fetch-native.ts` downloads prebuilt native binaries for Linux and Windows, eliminating the need for local C++ build tools.
* Desktop system tray (`electron/main.ts`) monitors `/api/app-status` and animates the tray icon when background tasks or queue workers are running.
* GitHub Actions (`.github/workflows/release.yml`) builds AppImage and Portable ZIP packages upon pushes or merges to the `main` branch.

---

## 6. Testing Strategy & Conventions

Tests reside in the `test/` directory and are run via Vitest:

* **Property & Regression Guards:** Tests must assert invariants and architectural properties rather than merely executing functions.
* **Edge Case Parsers:** Naive parser edge cases (empty strings, `msgid "0"`, escaped quotes, significant trailing whitespace, plural forms) are tested against `test/fixtures/edge-cases.po`. Add to this fixture rather than creating new ones.
* **Query Plan & Performance Tests:** Verify query execution plans using SQLite `EXPLAIN QUERY PLAN` to ensure statements hit required indexes without table scans.
* **Component Shape Tests:** Assert component structure and attributes to protect against subtle UI drift.

---

## 7. Deliberate Design Choices & Accepted Trade-offs

* **Synchronous SQLite:** Kept synchronous to guarantee transactional integrity and eliminate complex async locking. Long-running tasks must be broken into batches or run outside the SQLite thread.
* **Exact String Matching:** Glossary matching rejects normalization (such as aggressive trimming or case folding) because real-world catalogues demonstrate that normalized matches frequently map to incorrect translations.
* **Local-Only Security Boundary:** The application binds strictly to `127.0.0.1` and does not implement authentication. It assumes the local machine is secure.
* **GlotPress DOM Scraping:** WordPress.org does not provide a public write API for translations; queue reviewing relies on authenticated HTTP requests and DOM parsing. GlotPress UI template discrepancies are caught and recorded in `system_logs`.
* **One-Way Glossary Writes:** Edits made in a project or outputs generated by AI never write to `glossary_entries`. Only human-approved upstream imports and direct owner actions in the glossary screen may populate the glossary.
