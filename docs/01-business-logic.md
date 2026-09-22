# 01 — Business Logic & Feature Set

**Phase:** 1
**Status:** ⬜ Not started
**Prerequisite:** `00-process.md` signed off
**Exit criterion:** every step below is resolved, no `TBD` remains, and the owner signs off.

Baseline decisions (D1–D16) and findings (R1–R5) live in [`00-process.md`](00-process.md). This document refines them into a concrete feature set. It defines **what the system does**, never **how it is built** — technology belongs in `02-architecture.md`.

---

## Steps

### Step 1 — End-to-end workflows

**Goal:** write out each workflow as a numbered sequence, with the actor (owner or system) named at every step, and the failure branch stated.

Workflows to cover:
1. Add a curated source → fetch → ingest into the glossary
2. Re-sync an existing curated source (D4)
3. Import a target project (see O7)
4. Assign domain tags to a project (D6)
5. Auto-translate: exact match → AI fill (D7)
6. Review: approve / edit / reject
7. Glossary write-back on approval (D7)
8. Export PO for GlotPress (D1)

**Output:** one subsection per workflow.
**Status:** TBD

---

### Step 2 — Glossary / translation-memory entry model

**Goal:** define what a glossary entry *is*, in business terms.

To settle:
- What identifies an entry — is it the full source string, or a term/phrase? (The `item → ürün` example is a single word; PO entries are whole strings. Decide whether these are one concept or two.)
- How a domain tag attaches to an entry.
- Whether several translations may coexist for the same *(source, tag)* pair, and if so how one is chosen.
- What provenance is recorded: which source project it came from, whether it was owner-approved, when it was last seen.
- **O1** — does "newest wins" (D11) apply to owner-approved entries too, or only to externally-sourced ones?

**Status:** TBD

---

### Step 3 — Domain tag taxonomy

**Goal:** produce the actual tag list and its rules.

To settle:
- **Closed set or open vocabulary?** Undecided. The owner chose "AI proposes, owner confirms" (D6) and explicitly did *not* choose "fixed list + AI proposal", so nothing settles this yet. A closed set prevents synonym drift (`ecommerce` / `e-ticaret` / `shop`), which would silently break matching; an open vocabulary with autocomplete is more flexible.
- The concrete tag list — or, if open, the vocabulary it is seeded with (e-commerce, forms, SEO, membership, booking, …).
- How the AI's proposal (D6) maps onto that vocabulary, and what happens when it proposes something new.
- **O4** — one tag per project or several? Can an individual string override its project's tag?
- What happens when no tag fits — is there a `general` fallback, and how does matching behave against it?

**Status:** TBD

---

### Step 4 — Translation unit status model

**Goal:** define every state a string can be in, and the legal transitions between them.

Candidate states — to be confirmed, renamed or reduced:
`untranslated` · `memory-filled` · `ai-filled` · `approved` · `rejected` · `needs-work`

To settle:
- Which states are exportable to PO. Per R-note in `00-process.md`: GlotPress skips empty `msgstr`, so only approved strings should be emitted, and never with a `#, fuzzy` flag.
- What "reject" means concretely — does the string revert to untranslated, or is it parked with the rejected text kept for reference?
- Whether re-running AI on an already-reviewed project is allowed, and what it may overwrite.

**Status:** TBD

---

### Step 5 — QA rule catalogue (D9)

**Goal:** enumerate every automated check, and define the override mechanism.

Checks to specify — at minimum:
- `printf` placeholders: `%s`, `%d`, `%1$s`, `%%` — same set and same count as the source
- HTML tags and attributes: `<a href="…">`, `<strong>`, self-closing tags — balanced and matching
- Brace placeholders: `{count}`, `%(name)s` and similar plugin-specific conventions
- Plural arity (R3): `msgstr[0]` and `msgstr[1]` both present for plural entries
- Leading/trailing whitespace preserved
- Empty translation

To settle:
- Which checks are blocking versus advisory.
- The **exception record** (D9): what is stored — string, rule, reason, timestamp — and whether an exception survives re-import of the project.

**Status:** TBD

---

### Step 6 — Style guide structure (D12)

**Goal:** define the shape of the editable style guide.

To settle:
- The general Turkish rules to start with. Candidates, to confirm rather than assume: form of address (formal "siz" vs. informal), title capitalisation, suffix agreement, punctuation, how untranslatable product names are treated.
- How per-domain-tag overrides are expressed and how they combine with the general rules on conflict.
- How the guide reaches the AI — full text every request, or only the rules relevant to the project's tags.
- Who edits it and how it is versioned.

**Status:** TBD

---

### Step 7 — Source context rules (O3, D8)

**Goal:** define how the system decides where a string appears.

To settle:
- Heuristics mapping `#:` paths to a surface — e.g. `admin/`, `includes/admin/`, `class-*-settings.php` → admin; `public/`, `templates/`, `blocks/` → end-user facing.
- What happens when a string has several references pointing at different surfaces.
- What happens when there are no `#:` references at all.
- What else goes into the context bundle beyond the surface: `#.` extractor comments, the plugin's readme, its wp.org description.

**Status:** TBD

---

### Step 8 — Ingestion scope (O6, O7)

**Goal:** close the two ingestion questions.

To settle:
- **O6** — is `.po`/`.pot` upload into the glossary wanted alongside curated URLs? Note this is the only route for the ≈9 200-entry local WP core corpus (R5).
- **O7** — is the target project fetched by URL, or handed over as a downloaded file?
- If URLs are used: what the owner pastes (a project page URL, or a direct export URL) and how the system derives the rest.

**Status:** TBD

---

### Step 9 — Non-goals

**Goal:** write down explicitly what this tool will **not** do, so it does not drift back into being GlotPress.

Starting list — to confirm and extend:
- No users, login, registration, roles or permissions (D13)
- No locale other than `tr_TR` (D10)
- No `.mo` / `.l10n.php` generation (D1)
- No translator discussion threads, no priority/status workflow beyond Step 4
- No public or hosted deployment

**Status:** TBD

---

## Decisions

Decisions made *in this phase*. Baseline decisions D1–D16 are in `00-process.md`.

| # | Topic | Decision | Step |
|---|-------|----------|------|
| — | — | *none yet* | — |

---

## Open questions

| # | Question | Status |
|---|----------|--------|
| O1 | Does "newest wins" (D11) apply to owner-approved glossary entries, or only to externally-sourced ones? | Open — Step 2 |
| O3 | Rules for deriving "admin vs. end-user facing" from `#:` paths | Open — Step 7 |
| O4 | Domain tag: single- or multi-valued per project; can a string override it? | Open — Step 3 |
| O8 | Is the tag taxonomy a closed set or an open vocabulary? Not settled by D6. | Open — Step 3 |
| O6 | Is `.po`/`.pot` upload into the glossary also wanted? | Open — Step 8 |
| O7 | Target project ingestion: URL fetch or file upload? | Open — Step 8 |
