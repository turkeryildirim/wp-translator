# ADR-0001 — Technology stack

- **Status:** Open
- **Phase:** 2
- **Relates to:** D15

## Context

wp-translator is a single-user local tool. It exports PO files from translate.wordpress.org, maintains a glossary, downloads and stores plugin source code, calls an AI provider, presents a review panel, and exports PO for re-import into GlotPress.

The binding technical constraint is **PO round-trip fidelity**: `#:` references, `#.` comments, plural forms and headers must survive import → storage → export intact. A stack whose PO tooling is weak costs more than it saves.

**Owner's stated preference: Node + npm + SQLite.** Every data path is a plain HTTP GET (R5, R6) — no browser automation, no credentials — so the decision rests on PO tooling, AI SDK ergonomics, archive handling, and which language the owner wants to maintain this in.

Environment (R4) rules nothing out: PHP 8.5 with `intl` and `pdo_sqlite`, Node 24, Go, SQLite CLI 3.51, MariaDB, Docker/Podman are all present. The owner maintains projects in Laravel, Go and Node, so familiarity does not decide it either.

## Options

### A — Node + TypeScript + SQLite
- *For:* TBD
- *Against:* TBD

### B — PHP + SQLite
- *For:* TBD
- *Against:* TBD

### C — Go + SQLite
- *For:* TBD
- *Against:* TBD

## Decision

TBD

## Consequences

TBD
