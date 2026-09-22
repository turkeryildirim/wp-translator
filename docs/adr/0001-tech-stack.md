# ADR-0001 — Technology stack

- **Status:** Proposed
- **Date:** TBD
- **Phase:** 2 — see [`../02-architecture.md`](../02-architecture.md), Step 1
- **Relates to:** D15

## Context

wp-translator is a **single-user, local** tool (D13). It imports GlotPress PO exports, maintains a contextual glossary, calls an AI provider, presents a review panel, and exports PO for re-import into translate.wordpress.org.

The binding technical constraint is **PO round-trip fidelity**: `msgctxt`, `#:` source references, `#.` extractor comments, plural forms and headers must all survive import → storage → export (R1, R2, R3). A stack whose PO tooling is weak will cost more than it saves.

Environment as verified on 2026-09-22 (R4): PHP 8.5.10 + Composer 2.10.3 with `pdo_sqlite`, `sqlite3`, `gettext`, `mbstring`, `curl`, `zip` — but **no `intl`**. Node 24.18.0 + npm 11.16.0. Go. MariaDB 11.8.8. Docker / Podman. WP-CLI 2.12.0.

The owner already maintains projects in Laravel (`laravel-api-spec`, `Ruler`), Go (`solopanel`) and Node (`job-crawler`), so familiarity does not decide this on its own.

## Options considered

### A — PHP + Laravel + SQLite
- *For:* TBD
- *Against:* TBD

### B — Node.js + TypeScript + SQLite
- *For:* TBD
- *Against:* TBD

### C — Go + SQLite
- *For:* TBD
- *Against:* TBD

## Decision

TBD

## Consequences

TBD
