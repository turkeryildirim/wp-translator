# 00 — Process

**Project:** wp-translator — AI-assisted, glossary-grounded `tr_TR` translation of WordPress plugins and themes.
**Owner:** single user, Turkish GTE on translate.wordpress.org.

This file is the roadmap and the decision register. It is deleted once all phases close.

---

## 1. Purpose

Many WordPress plugins and themes have no Turkish translation. This tool translates them with AI assistance, kept **consistent** by grounding the AI in translations that humans have already made, reviewed and approved.

GlotPress is not used directly because it carries a large amount of functionality the owner never touches, offers no personal glossary, and cannot run AI translation. The output is a **PO file** the owner imports into translate.wordpress.org with their GTE rights.

---

## 2. Documentation rules

- **No history.** Documents state what is true now. No "was X, then became Y", no changelog, no record of completed work — git holds that.
- **Task-bearing files** mark a finished step `Closed` and move on. When every step closes, the file is deleted.
- **Spec files** (`01`, `02`, `03`) are living descriptions in the present tense, not activity logs.

---

## 3. Phases

Each phase produces one document. **The owner signs it off before the next phase starts.** No implementation code until `03-web-ui.md` is signed off.

| Phase | Document | State |
|-------|----------|-------|
| 0 | `docs/` skeleton and baseline | Closed |
| 1 | `01-business-logic.md` | Open |
| 2 | `02-architecture.md`, `adr/0001-tech-stack.md`, `adr/0002-ai-provider.md` | Not started |
| 3 | `03-web-ui.md` | Not started |
| 4 | Implementation, in vertical slices | Not started |

---

## 4. Decision register

| # | Topic | Decision |
|---|-------|----------|
| D1 | Output | **PO only.** No `.mo` / `.l10n.php`. |
| D2 | Input | GlotPress **PO** export. |
| D3 | Glossary source | A URL-based list of **trusted projects**, maintained in the panel and exported from translate.wordpress.org. No file upload, no automatic crawling. |
| D4 | Glossary refresh | Owner presses "update"; every project on the list is re-exported and re-imported. |
| D5 | Context model | **Domain tag.** `msgctxt` is not a matching dimension. |
| D6 | Tag assignment | AI proposes from stored project metadata; owner confirms, corrects or adds. |
| D7 | Pipeline | Glossary match placed automatically → owner triggers AI for the remainder → owner reviews → approved entries feed the glossary. |
| D8 | AI context | Project metadata, readme, wp.org description, the stored **source code**, glossary terms, style rules. |
| D9 | QA validation | Blocking, with per-string exception override and recorded reason. |
| D10 | Language | `tr_TR` only. |
| D11 | Glossary conflict | The trusted source wins over the owner's own entries. Trusted projects are human-translated, reviewed and approved. |
| D12 | Style guide | General Turkish rules plus per-tag rules, editable in the panel, injected into every AI request. |
| D13 | Users / auth | None. Single user, local. |
| D14 | Docs language | English. |
| D15 | Stack | Open — `adr/0001-tech-stack.md`. Owner's stated preference: Node + npm + SQLite. |
| D16 | AI provider | Open — `adr/0002-ai-provider.md`. |
| D17 | Sync autonomy | The trusted-source cycle runs unattended: existing entries updated, new added, entries removed upstream deleted. The owner supplies the list and presses the button; nothing else is confirmed. |
| D18 | Tag cardinality | A project carries **several** tags. |
| D19 | Tag vocabulary | **Open and owner-controlled.** AI proposes; the owner may correct or add tags. |
| D20 | Project ingestion | The owner supplies the project's wordpress.org page and its translate.wordpress.org page; the tool exports the PO automatically into a per-project store, separate from the glossary. |
| D21 | Source code | The plugin/theme **source code is stored locally** next to its language file, so file names, directories and the code itself reveal where a string is used. |
| D22 | Status model | `untranslated` → glossary match is placed as complete without review; AI output is `review`; approval makes it `ok`. Rejection is not a state — it means the owner edits and saves the string. |
| D23 | Glossary write-back | An approved translation is added to the glossary if absent. If a different translation already exists, the system warns. |
| D24 | `msgctxt` | Carried verbatim through import → storage → export. Not used for matching, not shown in the UI, not stored in the glossary. It exists solely so GlotPress can match the entry on import. |
| D25 | Source code | Downloaded automatically as the versioned ZIP from `downloads.wordpress.org`. |
| D26 | Glossary status filter | Only `current` translations feed the glossary. `waiting` is unreviewed and would dilute it. |
| D27 | Sub-project | **`dev` when the project has one, otherwise `stable`.** Where `dev` exists, `stable` is not consulted. Large projects carry both; small ones often only one. |
| D28 | readme | The readme sub-project is **not** a translation target. `readme.txt` is read only as context for tag proposal and AI translation. |

---

## 5. Constraints

**R1 — PO on import, not JSON.** Deciding where a string appears (D8) needs the PO's `#:` source references and `#.` extractor comments. The GlotPress JSON/Jed export drops both and encodes context as `ctx\u0004msgid`.

**R2 — `msgctxt` on export.** GlotPress matches an incoming PO entry to an existing original by singular + plural + **context**. An exported entry that omits a `msgctxt` the original carries does not match, and that translation is lost on import. Verified against a live export: Classic Editor, a 54-string plugin, carries 8 `msgctxt` entries — `Block editor`, `Classic editor` and `block editor` all under `msgctxt "Editor Name"`. Handled by D24.

**R3 — Plural forms.** `nplurals=2; plural=n > 1;`. `msgid_plural` / `msgstr[0]` / `msgstr[1]` must be modelled, and QA must validate plural arity.

**R4 — Environment.** PHP 8.5.10 + Composer 2.10.3 (`intl` ICU 77.1, `pdo_sqlite`, `gettext`, `mbstring`, `curl`, `zip`); Node 24.18.0 + npm 11.16.0; Go; MariaDB 11.8.8; SQLite CLI 3.51.2; Docker / Podman; WP-CLI 2.12.0; git 2.55.0.

**R5 — GlotPress export access, verified.** `https://translate.wordpress.org/projects/wp-plugins/<slug>/stable/tr/default/export-translations/?format=po` returns **HTTP 200 with a PO body and no authentication**. `filters[status]=current|waiting|untranslated` works and changes the payload. No rate-limit headers are advertised. Exports carry `#:` references, `#.` comments and `msgctxt`. **No headless browser and no stored credentials are needed to read exports.**

**R5b — URL shapes and the sub-project probe, verified.**

- Plugins: `…/projects/wp-plugins/<slug>/<stable|dev>/tr/default/export-translations/?format=po`
- Themes: `…/projects/wp-themes/<slug>/tr/default/export-translations/?format=po` — **themes have no sub-project**; `/stable` and `/dev` both 404.
- A missing sub-project or project returns **HTTP 404 with a ~116 KB HTML error page**. The probe behind D27 must therefore test the status code. Treating "bytes were returned" as success would store an HTML page as if it were a PO file.

**R6 — wordpress.org metadata APIs, verified.** Both are public GETs needing only the slug:

- `api.wordpress.org/plugins/info/1.2/?action=plugin_information&request[slug]=<slug>`
- `api.wordpress.org/themes/info/1.2/?action=theme_information&request[slug]=<slug>&request[fields][tags]=1&request[fields][sections]=1`

One call returns `name`, `version`, `download_link` (the versioned ZIP), `tags`, and `sections` (`description`, `faq`, `changelog`, …). This covers the project metadata behind D6 and D8 and the ZIP behind D25, without scraping the wordpress.org page. `downloads.wordpress.org/plugin/<slug>.<version>.zip` and `downloads.wordpress.org/theme/<slug>.<version>.zip` both return 200.

---

**R7 — `stable` and `dev`, measured.** Five plugins were checked; **all five expose both sub-projects**, so "use `dev` where it exists" resolves to "always `dev`" in practice.

Neither sub-project is a superset of the other:

| Plugin | stable | dev | shared | only in stable | only in dev |
|--------|-------:|----:|-------:|---------------:|------------:|
| contact-form-7 | 442 | 429 | 378 | 64 | 51 |
| wordpress-seo | 2 580 | 2 606 | 2 566 | 14 | 40 |
| woocommerce | 14 711 | 14 523 | 14 280 | 431 | 243 |
| classic-editor | 53 | 53 | 53 | 0 | 0 |
| wp-super-cache | 492 | 492 | 492 | 0 | 0 |

Source alignment against the released ZIP (contact-form-7 6.1.7):

| PO | references | files | files absent from ZIP | line overflows |
|----|-----------:|------:|----------------------:|---------------:|
| stable | 503 | 55 | 0 | 0 |
| dev | 492 | 58 | 5 | 1 |

`stable` aligns perfectly. `dev` references five trunk-only files (a refactored `admin/` tree) that the release ZIP does not contain, so roughly one reference in ten has no source code to read.

Two consequences follow from D27 and are accepted: strings that exist only in `stable` are not translated, and references pointing at trunk-only files fall back to the path and the `#.` comment without source code.

## 6. Open questions

| # | Question | Phase |
|---|----------|-------|
| O15 | R6 means the slug alone yields all project metadata and the ZIP. Does the owner still supply the wordpress.org page URL when adding a project, or is the translate.wordpress.org URL (which contains the slug) enough? | 1 |
| O13 | When approval collides with an existing, different glossary translation the system warns — and then what? Keep both as variants, replace, or leave the glossary untouched? | 1 |
| O14 | Is there an automated test suite, and what does it cover? Relevant because PO round-trip fidelity is the one thing a silent bug would corrupt invisibly. | 2 |

---

## 7. Skills per phase

| Phase | Skills |
|-------|--------|
| 1 | `product-management:write-spec` |
| 2 | `engineering:system-design`, `sql-expert`, `engineering:architecture`, `claude-api` *(only if ADR-0002 selects Claude)* |
| 3 | `design:design-system`, `design:ux-copy`, `design:accessibility-review` |
| 4 | `code-standards`, plus the stack's own skill once ADR-0001 closes: `javascript` / `react` / `vuejs`, or `php` / `laravel` / `phpunit`, or `golang`. `wordpress` when plugin/theme specifics come up. `docker` if containerised. |
