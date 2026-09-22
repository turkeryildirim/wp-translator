# ADR-0001 — Technology stack

- **Status:** Open
- **Phase:** 2
- **Relates to:** D15

## Context

wp-translator is a single-user local tool. It exports PO files from translate.wordpress.org, maintains a glossary, downloads and stores plugin source code, calls an AI provider, presents a review panel, and exports PO for re-import into GlotPress.

The binding technical constraint is **PO round-trip fidelity**: `#:` references, `#.` comments, plural forms and headers must survive import → storage → export intact. A stack whose PO tooling is weak costs more than it saves.

**Owner's stated preference: Node + npm + SQLite.** The reason given was that headless-browser work might be needed. R5 removes that premise for the export path — the GlotPress export is a public GET returning a PO body, with no authentication and no browser automation required. Node may still be the right answer, but it needs a reason that survives R5: a named use for browser automation elsewhere, AI SDK ergonomics, or the owner simply preferring to work in it. Any of those is legitimate; the point is that the rationale should be the real one.

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
