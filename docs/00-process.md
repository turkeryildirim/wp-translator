# 00 — Process

**Project:** wp-translator — AI-assisted, glossary-grounded `tr_TR` translation of WordPress projects.
**Owner:** single user, Turkish GTE on translate.wordpress.org.

This file is the roadmap and the decision register. It is deleted once all phases close.

---

## 1. Purpose

Many WordPress projects have no Turkish translation. This tool translates them with AI assistance, kept **consistent** by grounding the AI in translations that humans have already made, reviewed and approved.

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
| 1 | `01-business-logic.md` | Closed |
| 2 | `02-architecture.md`, `adr/0001-tech-stack.md`, `adr/0002-ai-provider.md` | Open |
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
| D6 | Tag assignment | AI proposes from stored project metadata, choosing from the existing tag list first (D33); owner confirms, corrects or adds. Families without metadata are tagged by the owner directly. |
| D7 | Pipeline | Glossary match placed automatically → owner triggers AI for the remainder → owner reviews → approved entries feed the glossary. |
| D8 | AI context | Glossary terms and style rules always; project metadata, readme, wp.org description and the stored **source code** where the family provides them (D32). |
| D9 | QA validation | Blocking, with per-string exception override and recorded reason. |
| D10 | Language | `tr_TR` only. |
| D11 | Glossary conflict | The trusted source wins over the owner's own entries. Trusted projects are human-translated, reviewed and approved. |
| D12 | Style guide | General Turkish rules plus per-tag rules, editable in the panel, injected into every AI request. |
| D13 | Users / auth | None. Single user, local. |
| D14 | Docs language | English. |
| D15 | Stack | **Node + TypeScript + SQLite** — `adr/0001-tech-stack.md`. Only stack measured to round-trip a real export without loss, and the owner's preference. |
| D16 | AI provider | **A pluggable `TranslationProvider` interface** — `adr/0002-ai-provider.md`. The concrete provider roster is supplied by the owner later; nothing else waits on it. |
| D17 | Sync autonomy | The trusted-source cycle runs unattended: existing entries updated, new added, entries removed upstream deleted. The owner supplies the list and presses the button; nothing else is confirmed. |
| D18 | Tag cardinality | A project carries **several** tags. |
| D19 | Tag vocabulary | **Open and owner-controlled.** AI proposes; the owner may correct or add tags. |
| D20 | Project ingestion | The owner supplies the translate.wordpress.org URL (D31); the tool exports the PO automatically into a per-project store, separate from the glossary. Where the family supports it, metadata and source come from the wordpress.org API. |
| D21 | Source code | For plugins and themes the **source code is stored locally** next to its language file, so file names, directories and the code itself reveal where a string is used. |
| D22 | Status model | `untranslated` → glossary match is placed as complete without review; AI output is `review`; approval makes it `ok`. Rejection is not a state — it means the owner edits and saves the string. |
| D23 | Glossary write-back | An approved translation is added to the glossary if absent. On collision see D29. |
| D24 | `msgctxt` | Carried verbatim through import → storage → export. Not used for matching, not shown in the UI, not stored in the glossary. It exists solely so GlotPress can match the entry on import. |
| D25 | Source code | Downloaded automatically as the versioned ZIP from `downloads.wordpress.org`. Plugins and themes only (D32). |
| D26 | Glossary status filter | Only `current` translations feed the glossary. `waiting` is unreviewed and would dilute it. |
| D27 | Sub-project | **`dev` when the project has one, otherwise `stable`.** Where `dev` exists, `stable` is not consulted. Large projects carry both; small ones often only one. |
| D28 | readme | The readme sub-project is **not** a translation target. `readme.txt` is read only as context for tag proposal and AI translation. |
| D29 | Glossary collision | When an approved project translation differs from an existing glossary entry, the panel offers **two independent choices**: for the project — use the glossary translation or keep the project's; for the glossary — keep the existing entry or overwrite it. |
| D30 | Testing scope | Verification is limited to the **exported PO**: is it syntactically valid, and will GlotPress import it. No WordPress installation, no plugin activation, no runtime loading test. |
| D31 | Project identity | The owner supplies the **translate.wordpress.org URL**. A slug alone cannot locate a project — see R8. |
| D32 | Project families | Six families, each with its own import tab: **Core, Theme, Plugin, Apps, Meta, Patterns**. Themes and plugins are slug-driven — automatic ZIP download, metadata, readme, AI tag proposal; everything decided for them holds. `wp`, `apps`, `meta` and `patterns` are WordPress's own projects and may have no ZIP or readme, so the owner supplies the URL directly and those steps are skipped. Trusted sources are drawn from **all** families. |
| D33 | Tag drift | Prevention and repair together: the AI is given the existing tag list and told to choose from it before proposing a new one, and the panel offers a **merge** that moves every glossary entry and project from one tag to another. |
| D35 | Glossary key | `(source, msgctxt, tag)`. Matching prefers the unit's own `msgctxt` and falls back to the context-less row; a unit without context matches only context-less entries. Resolves R9. |
| D34 | Style guide form | A large free-text field in the panel, written by the owner, passed to the AI as part of the prompt. No structured rule editor. Per D12 the same form applies per tag. |

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
- A missing sub-project or project returns **HTTP 404 with a ~116 KB HTML error page**. The probe behind D27 must test the status code **and** the content type: a successful export is `application/octet-stream`, a 404 is `text/html`. Size is not a signal — `ry-wc-city-select` exports a legitimate 1.2 MB PO with 14 402 strings, larger than the error page.

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

**R8 — the project space is not uniform.** A slug does not identify a project: the type path and the sub-project depth both vary. All of the following export PO at `…/projects/<path>/tr/default/export-translations/?format=po`, verified:

| Path shape | Example | msgid | msgctxt | `#:` refs |
|------------|---------|------:|--------:|----------:|
| `wp-plugins/<slug>/<stable\|dev>` | `classic-editor/stable` | 54 | 8 | 53 |
| `wp-themes/<slug>` — no sub-project | `astra` | 4 142 | 91 | 6 083 |
| `wp/<branch>` | `wp/dev` | 8 143 | 1 182 | 12 746 |
| `wp/<branch>/<sub>` | `wp/dev/admin` | 3 663 | 204 | 4 319 |
| `patterns/<slug>` | `patterns/core` | 17 045 | 0 | 24 068 |
| `apps/<platform>/<branch>` | `apps/ios/dev` | 4 343 | **4 342** | **0** |
| `meta/<slug>` | `meta/learn-wordpress` | 981 | 323 | 1 135 |

A second URL form exists: `…/locale/tr/default/<type>/<slug>/` is an HTML page that **lists a project's sub-projects** — for `ry-wc-city-select` it shows `stable`, `dev`, `stable-readme`, `dev-readme`. It is the natural discovery input.

Two consequences:

- **`apps/ios` has no `#:` references at all** and carries `msgctxt` on 4 342 of 4 343 strings. Source-code usage detection (D21) is meaningless there, and `msgctxt` is the only context available — which D24 deliberately does not read.
- **The wordpress.org info API and the source ZIP exist only for `wp-plugins` and `wp-themes`.** For `wp`, `patterns`, `apps` and `meta` there is no `download_link` and no tags line, so D6, D8, D21 and D25 have nothing to work with.

**R9 — dropping `msgctxt` from the glossary collapses real distinctions.** D24 keeps `msgctxt` out of the glossary, and D5 keys the glossary on `(source, tag)`. Measured across live exports, counting source strings that appear more than once under different `msgctxt` **and carry genuinely different translations**:

| Project | entries | repeated `msgid` | conflicting translations |
|---------|--------:|-----------------:|-------------------------:|
| WooCommerce `dev` | 14 530 | 166 | **43** |
| WordPress core `dev` | 8 142 | 314 | **52** |
| Astra | 4 141 | 9 | 1 |
| Yoast SEO `dev` | 2 606 | 8 | 0 |

Real cases: `May` → `May` (abbreviation) against `Mayıs` (full month); `F j, Y` → two different date formats; `Excludes` → `Hariç tutar` against `Hariçler`. These are exactly what `msgctxt` exists to separate. Keying the glossary on source alone collapses these into one arbitrary winner, and quality checks cannot catch it — nothing is malformed, only wrong. WordPress core is both the worst affected and the most likely trusted source. Resolved by D35.

**R10 — SQLite `NOCASE` is ASCII-only.** Verified: `'ecommerce' = 'ECommerce' COLLATE NOCASE` is true, `'içerik' = 'İÇERİK' COLLATE NOCASE` is false. The collation on `tags.name` therefore only half-implements D33's prevention. Tag names must be normalised in the application with Turkish-aware case folding before insert.

**R11 — usage surface cannot be fully derived.** Path patterns decide 60.9 % of WooCommerce strings, 36.4 % of Contact Form 7, 20.4 % of Yoast SEO. Adding file-content signals lifts WooCommerce to 66.6 %. Classification is per file, not per string — WooCommerce's 14 523 strings touch 1 649 files, 15.2 strings each, scanned in 0.7 s. `unknown` stays a legitimate outcome: the surface is AI context, not a correctness gate.

**R12 — source excerpts must be capped.** 14 % of WooCommerce's referenced files are minified bundles and **31 % of all references point into them**; the largest single line is 1.73 million characters. An uncapped ±6-line excerpt has a median of 601 characters but a p90 of 65 425. Capping lines at 300 characters and excerpts at 2 000 gives a median of 134 tokens and a hard ceiling of 500. Files with lines over 2 000 characters yield no excerpt.

**R13 — normalising before matching is a net loss.** Measured over WooCommerce's 14 159 distinct source strings: collapsing whitespace gains 6 matches of which 5 have different translations; adding lowercase gains 253 of which **197** differ; adding trailing-punctuation stripping gains 484 of which **431** differ. `Saved for Later` is `Sonraya Kaydet` but `Saved for later` is `Sonraya kaydedildi`. Matching is therefore byte-exact, and quality checks cannot catch a wrong match because nothing is malformed.

## 6. Open questions

| # | Question | Phase |
|---|----------|-------|
| — | None open. |

---

## 7. Skills per phase

| Phase | Skills |
|-------|--------|
| 1 | `product-management:write-spec` |
| 2 | `engineering:system-design`, `sql-expert`, `engineering:architecture`, `claude-api` *(only if ADR-0002 selects Claude)* |
| 3 | `design:design-system`, `design:ux-copy`, `design:accessibility-review` |
| 4 | `code-standards`, plus the stack's own skill once ADR-0001 closes: `javascript` / `react` / `vuejs`, or `php` / `laravel` / `phpunit`, or `golang`. `wordpress` when plugin/theme specifics come up. `docker` if containerised. |
