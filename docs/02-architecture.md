# 02 — Architecture

How the system described in [`01-business-logic.md`](01-business-logic.md) is built. Constraints R1–R5 and the decision register are in [`00-process.md`](00-process.md).

This document is filled in Phase 2. Sections below state what is already settled and what remains to be decided.

---

## Technology stack → `adr/0001-tech-stack.md`

Judged against:

- **PO round-trip fidelity** — the hard requirement. `msgctxt`, `#:`, `#.`, plural forms and headers must survive import → storage → export.
- Library support for parsing and serialising PO.
- AI SDK support for whichever provider ADR-0002 selects.
- Single-user local deployment: how the owner starts it, where data lives.
- Downloading and unpacking plugin/theme source archives.

The export path needs no browser automation and no credentials (R5).

---

## AI provider → `adr/0002-ai-provider.md`

The decisive criterion is **instruction adherence**, not fluency. Quality checks are blocking, so a model that writes elegant Turkish while dropping a `%1$s` or a `</strong>` creates review work instead of removing it. Honouring the glossary and the per-tag style rules matters for the same reason: consistency is the point of the project.

Secondary: cost per project at realistic string counts, throughput, and whether the interface is abstracted so providers can be swapped.

---

## Data model

Entities:

- **trusted sources** — translate.wordpress.org URL, label, last export time
- **glossary entries** — source string, translation, domain tags, provenance (which trusted project, or owner approval), plural forms
- **projects** — family, slug or path, translate.wordpress.org URL, sub-project, metadata where available (name, version, description, readme, tags), assigned domain tags
- **project source snapshots** — the stored plugin/theme code, with the version it corresponds to
- **translation units** — source string, `msgid_plural`, `msgctxt`, `#:` references, `#.` comments, translation, state, provenance, derived usage surface
- **domain tags** — open vocabulary, mergeable (D33): a merge has to rewrite every referencing row, so tags are referenced by id rather than by name
- **style rules** — free text: one general, one per tag (D34)
- **QA exceptions** — unit, rule, reason, time

Raw exported PO files are kept on disk as well as imported into the database, for both the glossary and each project.

**Open:** whether the glossary and per-project stores are separate databases or separate tables in one.

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
