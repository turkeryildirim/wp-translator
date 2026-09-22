# ADR-0001 — Technology stack

- **Status:** Accepted
- **Phase:** 2
- **Relates to:** D15

## Context

wp-translator is a single-user local tool. It exports PO files from translate.wordpress.org, maintains a glossary, downloads and unpacks plugin and theme source archives, calls an AI provider, presents a review panel, and exports PO for re-import into GlotPress.

The binding constraint is **PO round-trip fidelity**: `msgctxt`, `#:` references, `#.` extractor comments, plural forms and headers must survive import → storage → export. A failure here is silent — it only surfaces after the PO reaches GlotPress.

Every data path is a plain HTTP GET (R5, R6): no browser automation, no credentials. Environment (R4) rules nothing out. The owner maintains projects in Laravel, Go and Node, so familiarity does not decide it either.

**Owner's stated preference: Node + npm + SQLite.**

## Measured: PO round-trip fidelity

Each language's leading off-the-shelf PO library was made to parse and re-serialise the WooCommerce `dev` export — 14 531 entries, 25 083 references, 1 647 extractor comments, 720 `msgctxt`, 228 plurals, 2.9 MB. Content was then compared as a multiset against the source, using an independent parser.

| | Node `gettext-parser` 9.1.1 | PHP `gettext/gettext` 5 | Go `gotext` 1.7.2 |
|---|---|---|---|
| Entries | **14 531 / 14 531** | 14 528 — **3 lost** | 14 531 / 14 531 |
| `msgctxt` | **720 / 720** | 718 — **2 lost** | **720 / 720** |
| Plurals | **228 / 228** | **228 / 228** | **228 / 228** |
| `#:` references | **25 083 / 25 083** | 25 083 / 25 083 | 14 704 — **41 % lost** |
| `#.` comments | **1 647 / 1 647** | 1 646 — 1 lost | 0 — **all lost** |
| Translation text | **identical** | identical | **170 entries mangled** |
| Entry order | not preserved | preserved | not preserved |
| Parse / write | 341 ms / 108 ms | 520 ms / 221 ms | 22 ms / 161 ms |

**Node** is the only one that survives intact. Its two deviations are cosmetic: entries are re-sorted, and the header charset is lowercased (`UTF-8` → `utf-8`, case-insensitive per RFC).

**PHP** silently drops exactly the entries whose `msgid` is the string `"0"` — three of them in WooCommerce. `"0"` is falsy in PHP, so a truthiness check discards it. The source contains no duplicate keys, so this is a library defect rather than key collapsing.

**Go** loses every extractor comment and 41 % of source references, and mangles 170 translations through quote-escaping. `#.` comments and `#:` references are exactly what D8 feeds the AI, so this removes the tool's main advantage.

Entry order turns out **not** to be a requirement: GlotPress matches an imported entry by singular + plural + context, not by position. Re-sorting is therefore harmless, and should not count against a library.

These measurements describe the leading off-the-shelf library in each language, not the language itself. A hand-written parser is viable anywhere — PO is a simple format — but it is work that Node alone does not require.

## Options

### A — Node + TypeScript + SQLite

- Only stack whose PO library passes without loss, verified above.
- Matches the owner's stated preference.
- One language across backend and panel.
- Richest AI SDK ecosystem, which matters for ADR-0002.
- Handles ZIP natively; SQLite via `better-sqlite3`, synchronous and well suited to a single-user local tool.

### B — PHP + SQLite

- Closest to the owner's WordPress work, and PHP understands the domain natively.
- `intl`, `pdo_sqlite`, `gettext` and `zip` are all present (R4).
- Requires either working around the `"0"` defect or writing the parser.

### C — Go + SQLite

- Single binary, no runtime to install, fastest parser measured.
- PO tooling is the weakest of the three; a hand-written parser is effectively mandatory.
- Least suited to the panel, which is the part the owner will actually live in.

## Decision

**Option A — Node + TypeScript + SQLite.**

It is the only stack measured to round-trip a real WooCommerce export without loss, and it is what the owner wants to work in. The two agree, so there is nothing to trade away.

## Consequences

- **PO handling** uses `gettext-parser`. Its two deviations are accepted: entries are re-sorted (harmless — GlotPress matches by content, not position) and the header charset is lowercased (case-insensitive per RFC). Both are asserted in the export tests so a future version changing behaviour is caught.
- **The `"0"` case becomes a test fixture**, not because Node fails it but because it is the cheapest known probe for this class of defect. Any replacement library or hand-written parser must pass it.
- **Storage** is SQLite. `better-sqlite3` is synchronous, which suits a single-user local tool: no connection pool, no async ceremony around what is effectively a local file.
- **One language across backend and panel**, so the review screen and the import pipeline share types — a translation unit is one definition, not two that drift.
- **Source archives** unpack in-process; no external `unzip` dependency.
- The panel's framework is left to Phase 3, constrained only to something that runs in this stack.
- Node 24.18 and npm 11.16 are already installed (R4); nothing new is required to start.
