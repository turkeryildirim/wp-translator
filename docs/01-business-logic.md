# 01 — Business Logic

What the system does. Technology choices belong in [`02-architecture.md`](02-architecture.md); the decision register and constraints are in [`00-process.md`](00-process.md).

---

## Problem

WordPress projects — plugins, themes, core, the mobile apps, meta sites and patterns — reach Turkish users untranslated. Translating them by hand is slow, and translating them with a general-purpose AI produces text that is fluent but inconsistent: the same source word comes out differently in every project, and sometimes differently within one project.

Consistency is the whole difficulty. `item` is *ürün* in an e-commerce plugin and *öge* elsewhere. The knowledge that resolves this already exists — in translations that humans have made, reviewed and approved on translate.wordpress.org over many years — but it is not reachable as a glossary, and GlotPress cannot apply it automatically.

## Goals

1. Reuse existing human translations verbatim wherever the same source string recurs, rather than re-translating it.
2. Make AI output consistent with those translations by handing the AI the relevant glossary terms, the project's domain, and evidence of where the string is used.
3. Keep every AI translation under human review before it counts as finished.
4. Grow the glossary from the owner's own approvals, so the system improves with use.
5. Produce a PO file that imports into translate.wordpress.org without losing entries.

## Non-goals

- No users, login, registration, roles or permissions. One person uses this on their own machine.
- No locale other than `tr_TR`.
- No `.mo` or `.l10n.php` generation.
- No translator discussion, no priority queues, no review workflow beyond approve-or-edit. That is GlotPress's job, and re-implementing it is why this tool would stop being worth having.
- No submitting translations back to translate.wordpress.org. The owner imports the PO there by hand, with their GTE rights.
- No public or hosted deployment.

---

## Workflow A — Trusted sources and the glossary

The glossary is built from projects whose Turkish translations are known to be good, because humans translated, reviewed and approved them.

1. The owner maintains a list of **trusted projects** in the panel, identified by their translate.wordpress.org URL. The list is editable at any time.
2. The owner presses **Update**. For every project on the list the PO is exported from translate.wordpress.org and saved locally as a file. Only `current` translations are exported — `waiting` strings have not been reviewed and would dilute the glossary with exactly the inconsistency it exists to prevent.
3. Each file is imported into the glossary database: entries already present are **updated**, entries not present are **added**, and entries that have disappeared upstream are **deleted**.
4. The cycle runs unattended. The owner supplies the list and starts it; nothing in between asks for confirmation.

Where a trusted source and an entry the owner approved themselves disagree, **the trusted source wins** — it carries more human review than a single approval does.

Where two trusted sources disagree, the translation **most of them agree on** wins. Ties go to the order of the trusted-source list, which the owner sets. In practice ties are the common case: measured across five sources, 88 % of disagreements are two-way, so the list order is what decides.

**Acceptance criteria**

- [ ] A project can be added to, edited in, and removed from the trusted list.
- [ ] Update processes every project on the list, one export at a time.
- [ ] Re-running Update with no upstream change leaves the glossary unchanged.
- [ ] An entry deleted upstream is gone from the glossary after the next Update.
- [ ] An entry the owner approved is replaced when a trusted source carries a different translation.
- [ ] Raw exported PO files are retained on disk alongside the imported rows.

---

## Workflow B — Translating a project

1. The owner adds a project by its **translate.wordpress.org URL**, under the tab for its family. The `…/locale/tr/default/<type>/<slug>/` page lists a project's sub-projects and is the natural thing to paste.
2. For a plugin or theme, the system stores metadata — name, version, description, readme sections, tags — from the wordpress.org info API and downloads the matching **versioned source ZIP**. The ZIP is the released version, so references to trunk-only files have no code behind them. For core, apps, meta and patterns this step is skipped and the owner assigns tags directly.
3. The PO is exported automatically into a per-project store, kept **separate from the glossary**. The `dev` sub-project is used when the project has one; otherwise `stable`. Where `dev` exists, `stable` is not read — large projects carry both, small ones often only one. The readme sub-project is never imported; `readme.txt` serves only as context.
4. The AI proposes domain tags from the stored metadata. The owner confirms, corrects, or adds their own. A project carries several tags, and the vocabulary is open — the owner can introduce a tag that did not exist.
5. The owner starts translation. Every string with an exact glossary match under one of the project's tags is filled in automatically and counts as complete; progress is reported as a percentage. The owner can browse what was placed. Where the project's tags disagree — the same string carrying different translations under two of them — nothing is filled in: the string goes to `review` with both candidates shown, because that disagreement is exactly the distinction domain tags exist to make.
6. The owner then asks the AI to translate what is left. Progress is reported the same way. **AI output is marked `review`, never `ok`.**
7. The owner works through the `review` strings. Approving one makes it `ok`. Rejecting is not a separate outcome — it means the owner edits the string and saves their own wording, which is likewise `ok`.
8. Approved translations are written into the glossary if the source string is not already there. If it is there with a **different** translation, the owner is shown both and makes two independent choices:
   - *for this project* — use the glossary translation, or keep the one just approved;
   - *for the glossary* — keep the existing entry, or overwrite it with the new one.

   Overwriting an entry that came from a trusted source lasts until that source is next synced, since the trusted source wins there (D11). The project keeps whichever translation was chosen for it either way.
9. The owner exports the project as PO for import into GlotPress.

**Acceptance criteria**

- [ ] Adding a project stores metadata, source code and the exported PO before translation can start.
- [ ] Glossary matching honours the project's tags.
- [ ] A string filled from the glossary is not sent to the AI.
- [ ] AI-filled strings land in `review` and cannot reach `ok` without the owner acting on them.
- [ ] Editing a string and saving it produces `ok`, with provenance recorded as human.
- [ ] Approval adds the string to the glossary when absent, and on collision offers the project choice and the glossary choice separately.
- [ ] Export emits only `ok` strings, with no `#, fuzzy` flag, no empty `msgstr`, and no `#~` obsolete entries.
- [ ] Every `msgctxt` present on import is present, unchanged, on export.
- [ ] The downloaded source version matches the version the PO was exported from.

---

## Translation unit states

| State | Meaning | Reached by |
|-------|---------|------------|
| `untranslated` | No translation yet. | Import |
| `review` | Not yet settled by the owner. | AI fill, or a glossary match whose candidates disagree |
| `ok` | Final. Exportable. | Glossary match, owner approval, or owner edit |

An unambiguous glossary match arrives at `ok` directly — it is already human-approved work, so asking the owner to re-approve it would be busywork. An ambiguous one does not: two tags offering different translations is a real question only the owner can answer. Provenance (`glossary`, `ai`, `human`) is recorded separately from state, so the owner can still find and inspect glossary-filled strings.

Only `ok` strings are exported.

---

## Project families

Six families, each with its own import tab. They differ in what the system can learn about a project without being told.

| Family | Path | Slug-driven | ZIP + metadata | Tags |
|--------|------|-------------|----------------|------|
| Plugin | `wp-plugins/<slug>/<dev\|stable>` | yes | yes | AI proposes |
| Theme | `wp-themes/<slug>` | yes | yes | AI proposes |
| Core | `wp/<branch>[/<sub>]` | no | no | owner |
| Apps | `apps/<platform>/<branch>` | no | no | owner |
| Meta | `meta/<slug>` | no | no | owner |
| Patterns | `patterns/<slug>` | no | no | owner |

Plugins and themes get the full treatment: the slug yields metadata, readme and a versioned source ZIP, so tags are proposed and usage surface is derived from real code.

The other four are WordPress's own projects — core, the mobile apps, the meta sites, the pattern directory. They often have no ZIP and no readme, so the owner supplies the URL and assigns tags directly, and the AI works from the string, its `#.` comment and whatever `#:` references exist. `apps` has none at all.

Trusted sources are drawn from **every** family: some core, apps and meta projects are among the best-reviewed Turkish translations there are.

---

## Domain tags

Tags describe what a project *is about*, and they are what makes `item → ürün` possible in one project and `item → öge` in another. They attach to the project, and through it to every translation unit in that project and every glossary entry derived from it.

- A project carries several tags.
- The vocabulary is open. The AI is shown the existing tags and told to choose from them before proposing anything new; the owner may still add one.
- For plugins and themes, tags are proposed from stored metadata: title, description, readme and the wordpress.org Tags line. Other families are tagged by the owner.

Synonyms (`ecommerce` / `e-ticaret` / `shop`) would split the glossary silently, so two things guard against it: showing the AI the existing list keeps new tags rare, and the panel can **merge** one tag into another, moving every glossary entry and project with it.

---

## Where a string is used

A single source word can appear in both the admin screens and the front end of the same plugin, so the project's tags alone are not enough context for the AI. Three signals are available, in increasing order of reliability:

1. `#:` references in the PO — the file path and line number.
2. `#.` extractor comments — the developer's own note about the string.
3. **The stored source code itself** — the file name, its directory, and the surrounding code.

The source code is why it is kept locally: a path such as `includes/admin/class-settings.php` is a strong signal, but reading the call site settles cases the path cannot, including strings that genuinely appear in both places.

When a `#:` reference names a file the downloaded source does not contain — trunk-only files, since the ZIP is the released version — the path and the `#.` comment are used on their own.

`msgctxt` is a fourth signal that the system deliberately does **not** use. It is carried from import to export untouched, so GlotPress can match the entry, but it plays no part in matching, in the glossary, or in the UI.

---

## Quality checks

Placeholder and markup damage is the failure mode that matters, because a broken `%1$s` reaches real sites. Checks are **blocking**: a string that fails cannot be approved. The owner can override a specific string as a deliberate exception, and the reason is recorded.

Checked against the source string:

- `printf` placeholders — `%s`, `%d`, `%1$s`, `%%` — same set, same count
- HTML tags and attributes — balanced, matching, `<a href="…">` intact
- Brace and named placeholders — `{count}`, `%(name)s`
- Plural arity — both `msgstr[0]` and `msgstr[1]` present on plural entries
- Leading and trailing whitespace preserved
- Non-empty translation

---

## Style guide

A general Turkish style guide plus per-tag additions, editable in the panel and sent to the AI with every request. It is the main lever for tone and consistency that a term glossary cannot express.

The general rules cover at least: form of address, title capitalisation, suffix agreement, punctuation, and how untranslatable product names are treated. Per-tag rules extend the general ones and win where they conflict.

The guide is a large free-text field the owner writes and edits in the panel. There is no structured rule editor: the text goes to the AI as part of the prompt, so it is written the way it would be explained to a person.

---

## Open questions

None. This document is complete and awaiting sign-off.
