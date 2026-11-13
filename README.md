# WP Translator

An autonomous AI translation and review assistant designed for WordPress plugins, themes, and core localization into Turkish.

It keeps translations accurate and consistent by grounding language models in human-approved upstream translations from [translate.wordpress.org](https://translate.wordpress.org) and the official WordPress Turkish Glossary.

WP Translator runs entirely locally on your computer with a local SQLite database, offering both a standalone desktop application and a web interface.

---

## Key Features

* **Grounded Local Glossary:** Automatically imports curated trusted WordPress projects and official terminology. Existing approved translations are reused instantly without invoking AI.
* **Tag-Based Terminology & Style Guides:** Supports domain-specific vocabularies (e.g., standard WordPress vs. WooCommerce e-commerce terminology) paired with customizable style rules passed directly to the model.
* **Autonomous Queue Reviewer:** Directly connects to WordPress.org translation queues using your session cookie. Automatically scans pending suggestions across projects, applies local quality checks, uses AI to judge submissions, and approves or rejects rows in bulk or in dry-run mode.
* **Translation Review & PO Export:** Interactive paged queue with visual markers for invisible whitespace characters, inline quality check inspection with reason-based override, precise find-and-replace, and standard Gettext PO export.
* **AI Memory & Cache Management:** Caches model translation outputs and judgements. A dedicated screen allows searching, filtering, and deleting single or bulk memory entries to remove unwanted model responses.
* **Operational Logs & Diagnostics:** Built-in 7-day rolling system log that tracks GlotPress template changes, authentication states, queue progress, and engine errors.
* **Automatic Database Backups:** Automatically creates an online SQLite snapshot upon closing the desktop app, keeping the last 7 closing backups in your configuration folder.

---

## Desktop Application

Prebuilt portable releases are generated automatically for Linux and Windows:

* **Linux:** Portable AppImage (stores database in `~/.config/wp-translator/`)
* **Windows:** Portable ZIP with executable (stores database in `%APPDATA%\wp-translator\`)

Both packages run standalone without requiring system-level installation.

---

## Development & Source Execution

### Prerequisites

* **Node.js** >= 22 (runs directly from source using native type stripping)
* **pnpm** >= 9

### Quick Start

```bash
# 1. Install dependencies
pnpm install

# 2. Build the Vue panel
pnpm run build:panel

# 3. Start the local server
pnpm run serve
```

The web panel is served locally at `http://127.0.0.1:4173`.

To launch the desktop interface during development:
```bash
pnpm run build:electron
pnpm start
```

---

## CLI & NPM Commands

| Command | Purpose |
|---|---|
| `pnpm test` | Runs the full Vitest unit and integration test suite |
| `pnpm run test:watch` | Runs tests in interactive watch mode |
| `pnpm run typecheck` | Validates TypeScript contracts across server and CLI (`tsc --noEmit`) |
| `pnpm exec vue-tsc --noEmit -p tsconfig.json` | Validates types across Vue components and templates |
| `pnpm run dev:panel` | Starts the Vite development server with hot-module replacement for UI development |
| `pnpm run build:panel` | Compiles the production Vue panel into `dist/panel` |
| `pnpm run build:electron` | Compiles the Electron main process into `dist/electron` |
| `pnpm run build:all` | Builds both the panel and the Electron main process |
| `pnpm start` | Launches the Electron desktop application |
| `pnpm run serve` | Runs the HTTP backend directly from source (`src/cli/serve.ts`) |
| `pnpm run style-guide:sync` | Synchronizes the seeded style guide Markdown file into the database |
| `pnpm run dist:linux` | Fetches Linux native bindings and packages the Linux AppImage |
| `pnpm run dist:win` | Fetches Windows native bindings and packages the Windows Portable ZIP |

---

## AI CLI Configuration

WP Translator integrates with command-line AI tools installed on your system:

* **agy** (Gemini models via Google Antigravity CLI)
* **opencode** (OpenCode interpreter)
* **claude** (Anthropic Claude CLI)
* **codex** (Custom or automated scripts)

Models, executable paths, and arguments can be configured in the **Genel Ayarlar (Settings)** tab in the application.

---

## Configuration & Environment Variables

| Variable | Description | Default |
|---|---|---|
| `WPT_PORT` | Port for the local HTTP server | `4173` (falls back to an ephemeral port if occupied) |
| `WPT_DB` | Path to the SQLite database file | OS config directory in desktop app, or local `wp-translator.sqlite` in CLI |
| `WPT_PANEL` | Path to the compiled frontend panel directory | `dist/panel` |
