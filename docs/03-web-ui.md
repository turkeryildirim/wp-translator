# 03 — Web UI

The panel for the workflows in [`01-business-logic.md`](01-business-logic.md), built on the stack in [`adr/0001-tech-stack.md`](adr/0001-tech-stack.md).

A single-user local tool: no login, no registration, no roles, no onboarding. Design effort goes into review throughput and nowhere else.

---

## What the numbers demand

Review volume is the design constraint, and it is large:

| Project | strings | filled from glossary | **left to review** |
|---|---:|---:|---:|
| Classic Editor | 53 | 16 | 37 |
| Contact Form 7 | 432 | 51 | 381 |
| Astra | 4 141 | 323 | 3 818 |
| WooCommerce | 14 530 | — | thousands |

At five seconds per string, Astra is over five hours. Anything that costs an extra second per string costs an extra hour per project.

The second number that shapes this: **51–92 % of strings are technically risk-free** — no placeholders, no HTML, not plural, under 80 characters. Astra is 92 %, WooCommerce 81 %, Contact Form 7 78 %, WP Super Cache 51 %. For those strings the blocking quality checks catch nothing at all, because there is nothing malformed to catch. Review there is pure semantic judgement on short text.

Two conclusions follow, and they drive everything below:

1. **The primary review surface is a dense list, not one string at a time.** Most strings are short and most need only a glance. A form-per-string layout spends the screen on chrome and the user's time on navigation.
2. **The minority with technical structure deserve the detailed treatment.** Placeholders, HTML, plurals and long strings are where errors hide and where the checks have something to say.

---

## Screens

- **Projects** — everything added, per-family tabs (Plugin, Theme, Core, Apps, Meta, Patterns), with per-project progress.
- **Add project** — a translate.wordpress.org URL; then metadata, source and PO are fetched.
- **Project review** — the core, below.
- **Trusted sources** — the URL list, ordered (the order decides conflicts, R15), with **Update**.
- **Glossary** — search, filter by tag, edit, inspect which sources vouch for an entry.
- **Tags** — the vocabulary, with merge.
- **Style guide** — a large free-text field, plus one per tag.
- **Settings** — the opencode model and agent, and the preflight status.

---

## Project review

### Layout

A table, one row per string, with columns: state, source, translation, and a marker column for provenance and quality-check status. The translation cell is editable in place — no modal, no separate form, no navigating away to fix a word.

Rows are compact enough that twenty or more are visible at once. The source and translation sit side by side so the eye compares them horizontally without scrolling.

Selecting a row expands a detail panel beneath or beside it, carrying what the table cannot: `msgctxt`, the `#.` extractor comment, the `#:` references, the derived usage surface, the source-code excerpt where one was fetched, and which glossary terms were sent to the AI for that string. The detail panel opens automatically for rows with technical structure and stays closed for the plain ones.

### Keyboard

Bulk review is only tolerable on keys. The full map is part of this design, not an afterthought:

| Key | Action |
|---|---|
| `j` / `↓` | next row |
| `k` / `↑` | previous row |
| `Enter` | approve and move to the next unreviewed row |
| `e` | edit the translation in place |
| `Esc` | cancel the edit |
| `Ctrl+Enter` | save the edit and approve |
| `Space` | toggle the detail panel |
| `x` | toggle row selection for bulk actions |
| `/` | focus the filter box |
| `g` then `u` | jump to the first unreviewed row |
| `?` | show this map |

`Enter` is the whole flow for a string that is fine, and `e` → type → `Ctrl+Enter` for one that is not. Everything else is secondary.

### Triage

Reviewing 3 818 strings in source order wastes the user's attention on the easy ones. Filters exist so the risky work can be done first, while fresh:

- quality-check failures (blocked, and overridden)
- has placeholders, has HTML, is plural, is long
- provenance: glossary, AI, already edited by hand
- contains a term the glossary translates more than one way — the `item → ürün / öge` cases, where the AI was most likely to pick wrong
- free-text search across source and translation

Default sort puts blocked strings first, then strings carrying ambiguous terms, then the rest.

### Bulk actions

Approving a filtered set at once is the only way the volume is survivable, but it is also how a mistake becomes three thousand mistakes. Guards:

- bulk approve acts on the current selection, never on "all matching the filter" implicitly
- the count is in the button: **Approve 412 strings**
- strings failing a quality check are excluded from bulk approve and the button says so
- undo is available for the last bulk action

---

## Quality checks in the UI

Blocking validation has to be legible, not merely obstructive. The message states what differs, in the user's terms, not a rule code:

> Source has `%1$s` and `%2$s`. Translation has only `%1$s`.

> Source opens `<strong>` and closes it. Translation opens it but never closes it.

> Source has singular and plural forms. Translation has only one.

The approve action is disabled with the reason inline — never a disabled button whose reason lives in a tooltip nobody hovers.

**The override** is deliberate friction: a separate control, not a second click on approve, and it asks for a reason in one line. Overridden strings stay findable under their own filter afterwards, because an exception made at hour four of a review session deserves a second look later.

Before export: **12 strings blocked, 3 overridden** — with links to both sets.

---

## Long operations

Trusted-source Update, project import and AI translation all take minutes.

Each reports progress as work completed, not as a spinner: `Translating — 1 450 / 3 818`. No cost or token figures; opencode runs on a subscription (D40).

Failures name what failed and offer to retry only that: a chunk that fails leaves the rest of the project translated, and re-running picks up the remainder. Rate-limit failures say so plainly and are retried rather than reported as translation errors.

The preflight state is visible before translation can start: if opencode's service is down or no model is configured, the button is disabled and says which. Without this the run would simply hang (R17).

---

## Empty states

Each says what the screen is, why it is empty, and the one action that fills it:

- **Projects** — "No projects yet. Add one with its translate.wordpress.org address to start."
- **Glossary** — "The glossary is empty. Add trusted sources and run Update to fill it from translations that have already been reviewed."
- **Review, nothing left** — "All 3 818 strings reviewed. Export the PO to import it into GlotPress."

---

## Frontend approach

**Vue 3 + Vite**, TypeScript, talking to the Node process that owns the database over a JSON API.

The review table is the only genuinely interactive surface, and it sets the requirements: render thousands of rows without stalling, which means row virtualisation; keep keyboard focus stable while rows are edited, approved and re-sorted underneath it; and update a row in place after an approve rather than re-fetching.

Every other screen is a form or a list and imposes nothing.

Two things to get right early, because they are awkward to retrofit:

- **Focus and virtualisation interact badly by default.** A virtualised list unmounts rows that scroll out of view, and the focused row is exactly the one that must not be unmounted mid-edit. The edit state belongs to the table, keyed by unit id, not to the row component.
- **Approving re-sorts.** Under the default sort an approved row leaves its position. The cursor must land on the next *unreviewed* row, not on whatever slid into the old index — otherwise `Enter` held down approves the wrong strings, which is the one mistake that is both easy and expensive.
