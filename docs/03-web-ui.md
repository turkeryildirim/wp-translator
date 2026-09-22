# 03 — Web UI

**Phase:** 3
**Status:** ⬜ Not started
**Prerequisite:** `02-architecture.md` signed off
**Exit criterion:** every step resolved, no `TBD` remains, owner signs off. Implementation starts only after this.

The panel is a **single-user local tool** (D13): no login, no registration, no roles. Design effort goes into review throughput, not into account management.

---

## Steps

### Step 1 — Screen inventory

**Goal:** list every screen and what it is for.

Expected set — to confirm:
- **Project list** — everything imported, with progress (translated / reviewed / remaining)
- **Project review** — the core screen, see Step 2
- **Glossary browser & editor** — search, filter by domain tag, edit, delete, see provenance
- **Curated sources** — add, label, sync, view last-sync result (D3, D4)
- **Style guide editor** — general rules plus per-tag rules (D12)
- **Import / export** — bring a project in, take a PO out
- **Settings** — AI provider credentials, defaults

**Status:** TBD

---

### Step 2 — The review screen

This is where nearly all the owner's time is spent. It decides whether the tool is actually faster than translating by hand.

**Goal:** design the string review interaction.

To settle:
- Layout: list of strings versus one string at a time; how the source and the suggestion sit relative to each other
- **Provenance display** — was this an exact glossary match or AI output? It changes how much scrutiny a string deserves
- Context on show: `#:` references, `#.` comments, the derived surface (admin vs. end-user), plural forms
- **Actions:** approve, edit-then-approve, reject — and what reject does (per Phase 1, Step 4)
- **Keyboard-first flow.** Bulk review of hundreds of strings is only tolerable with keys, not clicks. Define the full shortcut map.
- Filtering and sorting: by status, by provenance, by QA failure, by search text
- Bulk operations, and what safeguards they need

**Status:** TBD

---

### Step 3 — QA presentation (D9)

**Goal:** make blocking validation legible rather than merely obstructive.

To settle:
- How a failing string is marked, and how the *reason* is stated in plain language ("source has `%1$s` and `%2$s`, translation has only `%1$s`")
- How the approve action is disabled, and how the owner can tell why without hunting
- The **exception override** flow: how it is triggered, how the reason is captured, how overridden strings stay visible afterwards
- A pre-export summary: how many strings blocked, how many overridden

**Status:** TBD

---

### Step 4 — Glossary and style guide editing

**Goal:** design the screens that maintain the system's long-term quality.

To settle:
- Glossary search and filtering at scale — the memory will hold tens of thousands of entries
- Editing an entry, and what happens to projects already translated using it
- Showing variants and provenance for one *(source, tag)* pair
- Whether the owner can add a glossary entry directly from the review screen while reviewing
- Style guide editing: plain text, structured rules, or a mix

**Status:** TBD

---

### Step 5 — Import, sync and progress feedback

**Goal:** make long-running operations legible.

To settle:
- Progress feedback for import, source sync, and AI translation — these take minutes, not milliseconds
- Whether the owner can keep working while a batch runs
- Error reporting: which strings failed, and how to retry only those
- The AI cost/usage indicator, if Phase 2 Step 7 calls for one

**Status:** TBD

---

### Step 6 — Frontend approach

**Goal:** choose how the UI is built, consistent with ADR-0001.

To settle:
- Server-rendered, SPA, or hybrid
- Component and styling approach
- How much interactivity the review screen genuinely needs
- Light/dark handling, and density — this is a tool for long working sessions

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
| — | — | *none yet* |
