# 02 — Architecture

**Phase:** 2
**Status:** ⬜ Not started
**Prerequisite:** `01-business-logic.md` signed off
**Exit criterion:** every step resolved, both ADRs accepted, no `TBD` remains, owner signs off.

This document turns the feature set from [`01-business-logic.md`](01-business-logic.md) into a technical design. Baseline in [`00-process.md`](00-process.md).

---

## Steps

### Step 1 — Technology stack → `adr/0001-tech-stack.md`

**Goal:** choose the stack and record why (D15).

Judge the candidates against:
- maturity of **PO parsing/serialising** libraries (round-trip fidelity is the hard requirement — R1, R2, R3)
- AI SDK support for the provider chosen in Step 2
- single-user **local** deployment: how the owner starts it, how it stores data
- the owner's existing familiarity (Laravel, Go and Node projects all exist in `~/Projects`)
- R4: PHP `intl` is **not** installed; the `sqlite3` CLI is absent though the PHP driver is present

**Status:** TBD

---

### Step 2 — AI provider → `adr/0002-ai-provider.md`

**Goal:** choose the provider and record why (D16).

Judge against:
- Turkish translation quality
- **instruction adherence** — not breaking `%1$s` placeholders or HTML, honouring the glossary and style guide. This matters more than raw fluency, because D9 makes violations blocking.
- cost per project at realistic string counts
- whether the interface should be abstracted so providers can be swapped

If Claude is selected, load the `claude-api` skill before designing the calls, and verify current model IDs, pricing and prompt-caching behaviour rather than relying on memory.

**Status:** TBD

---

### Step 3 — Data model

**Goal:** a schema that survives the PO round trip and supports the workflows from Phase 1.

Entities to model — at minimum:
- **curated sources** — URL, label, last synced, trust marker
- **projects** — slug, type (plugin/theme), wp.org metadata, readme, domain tags, import origin
- **translation units** — source text, `msgid_plural`, `msgctxt`, `#:` references, `#.` comments, translation(s), status, provenance (memory / AI / human), surface (admin vs. end-user)
- **glossary entries** — per Step 2 of Phase 1, with domain tag, provenance, variants
- **domain tags** — the taxonomy defined in Phase 1 (whether it is a closed set or an open vocabulary is decided there, not here)
- **style rules** — general and per-tag
- **QA exceptions** — string, rule, reason, timestamp
- **audit trail** — what changed, when

Cross-check every field against R2 and R3: nothing needed for a clean GlotPress re-import may be dropped.

**Status:** TBD

---

### Step 4 — PO import / export

**Goal:** define the round-trip strategy.

To settle:
- Library or hand-written parser; how header block, `Plural-Forms` and `X-Domain` are handled
- Preservation of `msgctxt`, `#:`, `#.`, and entry ordering (R2)
- Plural handling (R3)
- **Export rules:** emit only approved strings; never emit a `#, fuzzy` flag; never emit empty `msgstr`; never emit `#~` obsolete entries — GlotPress silently drops or mis-flags all three on import
- Encoding and line-wrapping behaviour, so diffs stay readable

**Status:** TBD

---

### Step 5 — translate.wordpress.org / wordpress.org integration

**Goal:** define how remote data is fetched, verified and cached.

To settle:
- **O2 — fetch one real export and inspect it** before the schema depends on it. Do not assume the URL shape.
- **Sub-project selection:** a plugin is split into `stable`, `dev`, `stable-readme` and `dev-readme`; themes have a single project. Decide which is imported, and whether the readme sub-project (the store-page description strings) is itself a translation target.
- Which translation statuses feed the glossary when seeding — `current` only, or also `waiting`? GlotPress exposes status filters on export; the choice trades coverage against trustworthiness.
- Caching, rate limiting, retry, and behaviour when offline.
- Fetching the wp.org project page and `readme.txt` for D6 and D8.

**Status:** TBD

---

### Step 6 — Matching engine

**Goal:** specify exact-match lookup (D7).

To settle:
- The normalisation applied before comparison (whitespace, case, trailing punctuation) and whether normalisation risks false matches.
- How the domain tag participates in the lookup, and the fallback order when the project has several tags or no match under its own tag.
- Behaviour when the glossary holds several candidates.

**Status:** TBD

---

### Step 7 — AI pipeline

**Goal:** specify how unmatched strings become translations.

To settle:
- Context bundle assembly (D8) and its token budget
- Batching: how many strings per request; how order and identity are preserved in the response
- Structured output format, and validation of the response before it is stored
- Running QA (D9) on AI output automatically
- Retry, partial failure, resumability, and cost control/reporting

**Status:** TBD

---

### Step 8 — Storage, configuration and runtime

**Goal:** how the tool runs on the owner's machine.

To settle:
- Database engine and where the file lives
- API keys and secret storage
- Start-up: script, container, or binary
- Backup of the glossary — it is the most valuable asset in the system
- Migration strategy as the schema evolves

**Status:** TBD

---

## Decisions

| # | Topic | Decision | Step |
|---|-------|----------|------|
| — | — | *none yet* | — |

---

## Open questions

| # | Question | Status |
|---|----------|--------|
| O2 | Verify translate.wordpress.org export URL patterns and rate limits against the live service | Open — Step 5 |
| O3 | Implementation of the admin vs. end-user heuristics defined in Phase 1 | Open — Step 3 |
| — | Which plugin sub-project(s) to import: `stable`, `dev`, `stable-readme`, `dev-readme` | Open — Step 5 |
