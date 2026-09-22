# 03 — Web UI

The panel for the workflows in [`01-business-logic.md`](01-business-logic.md). Filled in Phase 3.

A single-user local tool: no login, no registration, no roles. Design effort goes into review throughput, not account management.

---

## Screens

- **Trusted sources** — the URL list, editable, with an **Update** button that runs the whole sync and reports what changed.
- **Projects** — everything added, with per-project progress.
- **Add project** — wordpress.org URL and translate.wordpress.org URL; then metadata, source code and PO are fetched.
- **Project tags** — the AI's proposals, for the owner to confirm, correct or extend.
- **Project review** — the core screen, below.
- **Glossary** — search, filter by tag, edit, inspect provenance.
- **Style guide** — general rules and per-tag rules.
- **Settings** — AI provider credentials and defaults.

---

## Project review

Nearly all the owner's time is spent here. It decides whether the tool is faster than translating by hand.

Two entry points, matching Workflow B:

- After glossary matching: a table of what was placed, with the completion percentage. Browsing, not reviewing — these strings are already `ok`.
- After AI translation: the `review` queue, which is the actual work.

Requirements:

- **Keyboard-first.** Hundreds of strings are only tolerable with keys, not clicks. The shortcut map is part of this document.
- Provenance is visible — glossary match or AI output changes how much scrutiny a string deserves.
- Context on show: `#:` references, `#.` comments, the derived usage surface, plural forms, and a way to reach the source code around the call site.
- Actions: approve, edit-and-save. There is no reject button; editing *is* rejecting.
- Filter and sort by state, provenance, quality-check failure, and free text.

**Open:** one string at a time versus a list; bulk operations and what guards them; how the source-code excerpt is surfaced without stealing the screen.

---

## Quality checks in the UI

Blocking validation has to be legible, not merely obstructive.

- A failing string states its reason in plain language — "source has `%1$s` and `%2$s`, translation has only `%1$s`" — not a rule code.
- The approve action is disabled, and why is visible without hunting.
- The exception override captures a reason, and overridden strings stay findable afterwards.
- Before export: how many strings are blocked, how many overridden.

---

## Glossary and style guide

- Search and filtering that hold up at tens of thousands of entries.
- Inspecting an entry: its translation, tags, and which trusted project it came from.
- The collision warning from Workflow B step 8 — showing the existing translation against the one being approved.

**Open:** whether a glossary entry can be created directly from the review screen; what editing an entry does to projects already translated with it; whether the style guide is free text, structured rules, or both.

---

## Progress and long operations

Trusted-source Update, project import and AI translation all take minutes.

**Open:** progress reporting for each; whether the owner can work while one runs; how failures are reported and retried for only the affected items; whether AI cost is surfaced.

---

## Frontend approach

Follows ADR-0001.

**Open:** server-rendered, SPA or hybrid; component and styling approach; how much interactivity the review screen truly needs; density and light/dark, since this is a tool for long sessions.
