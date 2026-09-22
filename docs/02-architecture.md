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

R5 removes what had been the strongest argument for one stack: the GlotPress export needs no browser automation and no credentials, so a headless browser is not a requirement of the export path. If browser automation is still wanted for something else, that use must be named before it weighs on the decision.

---

## AI provider → `adr/0002-ai-provider.md`

The decisive criterion is **instruction adherence**, not fluency. Quality checks are blocking, so a model that writes elegant Turkish while dropping a `%1$s` or a `</strong>` creates review work instead of removing it. Honouring the glossary and the per-tag style rules matters for the same reason: consistency is the point of the project.

Secondary: cost per project at realistic string counts, throughput, and whether the interface is abstracted so providers can be swapped.

---

## Data model

Entities:

- **trusted sources** — translate.wordpress.org URL, label, last export time
- **glossary entries** — source string, translation, domain tags, provenance (which trusted project, or owner approval), plural forms
- **projects** — slug, type, wordpress.org URL, translate.wordpress.org URL, metadata (name, description, readme, tags), assigned domain tags
- **project source snapshots** — the stored plugin/theme code, with the version it corresponds to
- **translation units** — source string, `msgid_plural`, `msgctxt`, `#:` references, `#.` comments, translation, state, provenance, derived usage surface
- **domain tags** — open vocabulary
- **style rules** — general, and per tag
- **QA exceptions** — unit, rule, reason, time

Raw exported PO files are kept on disk as well as imported into the database, for both the glossary and each project.

**Open:** whether the glossary and per-project stores are separate databases or separate tables in one.

---

## PO import and export

Settled by R1–R3 and the export rules in `01`:

- Import PO, never JSON/Jed.
- Preserve `#:`, `#.`, plural forms, headers and entry order.
- Export only `ok` strings; never emit `#, fuzzy`, an empty `msgstr`, or a `#~` obsolete entry — GlotPress mis-flags or silently drops all three on import.

- Preserve `msgctxt` verbatim (D24). It is never read for matching, so it can be treated as an opaque column that travels with the unit.

**Open:** whether to use an existing PO library or write the parser. The decision hinges on whether a candidate library round-trips `msgctxt`, `#:`, `#.` and plural forms without normalising them away.

---

## translate.wordpress.org and wordpress.org integration

Verified (R5, R6): the export endpoint is a public GET returning a PO body, `filters[status]` works, and no rate-limit headers are advertised. The plugin and theme info APIs return name, version, `download_link`, tags and readme sections from the slug alone, so nothing needs scraping.

Project setup therefore makes three public calls per project — info API, versioned ZIP, PO export — all unauthenticated.

Still to settle:

- **Sub-project probing.** D27 probes the `dev` export URL and falls back to `stable` on 404. Per R5b this must be a status-code check: a 404 returns a large HTML body, so a byte-count or "response received" test would silently store an error page as a PO file. Themes take a different URL shape with no sub-project segment at all.
- **Status filtering** (O12) — which statuses feed the glossary.
- Actual request pacing. No rate limit is advertised, which is not the same as none existing; the trusted-source Update loop issues one request per project and should be deliberately paced and resumable.
- Fetching the wordpress.org project page and `readme.txt` for tag proposal and AI context.

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

**Open (O14).** PO round-trip is the one area where a silent bug corrupts data invisibly — a dropped `msgctxt` or a mangled placeholder only surfaces after the PO reaches GlotPress. If there is a test suite, that is what it is for. Offline fixtures are available locally: `~/Projects/investakademi/app/languages/` holds WP core `tr_TR` files with and without `msgctxt` and with plural forms, and `~/Projects/wc-sanal-pos/languages/` holds a file with none.

---

## Storage, configuration and runtime

**Open:** database engine and file location; AI API key storage; how the tool starts; backup of the glossary, which is the most valuable asset in the system and the only part that is expensive to rebuild; schema migration.
