# 00 — Process

**Project:** wp-translator — an AI-assisted, glossary-grounded translation tool for WordPress plugins and themes (`tr_TR`).
**Owner:** single user, Turkish GTE (Global Translation Editor) on translate.wordpress.org.
**Created:** 2026-09-22
**Status:** Phase 0 complete — Phase 1 not started.

---

## 1. Why this project exists

Many WordPress plugins and themes have no Turkish translation. The aim is to translate them with AI assistance **consistently**, by grounding the AI in translations that were already made by humans, used for a long time, and reviewed by more than one person.

GlotPress itself is not used because:
- it carries a large amount of functionality the owner never touches,
- it offers **no personal/custom glossary**,
- it **cannot run AI translation**.

The end product is a local, single-user tool. The output is a **PO file** that the owner imports back into translate.wordpress.org using their GTE rights.

---

## 2. How these documents work

Design happens in order, one document per phase. **Each document is reviewed and signed off by the owner before the next phase begins.** No implementation code is written until `03-web-ui.md` is signed off.

Every document has the same shape:
- an ordered list of **Steps** to work through, each with a detail subsection,
- a **Decisions** table, where each settled question becomes a numbered decision,
- an **Open questions** list.

Bodies start as `TBD`. A `TBD` is never resolved by assumption — it is either decided with the owner or explicitly deferred with a recorded reason.

| Document | Phase | Produces | Status |
|----------|-------|----------|--------|
| `00-process.md` | 0 | This roadmap and the shared baseline | ✅ Done |
| `01-business-logic.md` | 1 | Feature set, workflows, data lifecycle, glossary rules | ⬜ Not started |
| `02-architecture.md` | 2 | Stack, data model, components, pipeline, integrations | ⬜ Not started |
| `03-web-ui.md` | 3 | Panel information architecture, screens, interactions | ⬜ Not started |
| `adr/0001-tech-stack.md` | 2 | Technology stack decision | ⬜ Proposed |
| `adr/0002-ai-provider.md` | 2 | AI provider decision | ⬜ Proposed |
| — | 4 | Implementation, in vertical slices | ⬜ Not started |

---

## 3. Target workflow (the thing being designed)

1. The owner maintains a list of **trusted source projects** (URLs on translate.wordpress.org) whose Turkish translations are known to be good.
2. Those sources are fetched and ingested into a local **glossary / translation memory**, each entry carrying a **domain tag** (e-commerce, forms, SEO, …).
3. An untranslated plugin/theme is imported as a GlotPress **PO** export.
4. The project is given one or more domain tags — **AI proposes, owner confirms** — derived from its wordpress.org page and `readme.txt`.
5. **Exact glossary matches** on *(source text + domain tag)* are applied automatically and marked as coming from the memory.
6. Everything left over goes to **AI**, with a context bundle: the wp.org project page, the `readme.txt`, where the string appears (admin screen vs. end-user facing), the relevant glossary terms, and the style guide.
7. The owner reviews every string in a per-project panel: **approve / edit / reject**.
8. Approved — and edited-then-approved — translations are **written back into the glossary** with their context.
9. The project is exported as **PO** for import into GlotPress.

---

## 4. Decision log

Settled during the planning session on 2026-09-22.

| # | Topic | Decision |
|---|-------|----------|
| D1 | Output target | **PO only**, for import into translate.wordpress.org. No local `.mo` / `.l10n.php` artifact needed for now. |
| D2 | Input format | GlotPress export. **PO is mandatory** — see R1. |
| D3 | Glossary sources | A **user-curated list of trusted project URLs** maintained in the panel and **auto-fetched from translate.wordpress.org**. No automatic crawling of "top plugins". File upload is not part of this decision — see O6. |
| D4 | Glossary refresh | Curated sources are re-fetchable; an explicit **update / re-sync** flow is required. |
| D5 | Context model | **Domain tag only.** `msgctxt` is *not* a matching dimension — plugins and themes rarely use it. |
| D6 | Tag assignment | **AI proposes, owner confirms**, derived from the wp.org project page + `readme.txt` (title, description, Tags line). |
| D7 | Translation pipeline | Exact glossary match on *(source text + domain tag)* → AI fills the remainder → human approve / edit / reject → approved and edited-approved entries are written back to the glossary. |
| D8 | AI context bundle | wp.org project page, `readme.txt`, **where the string appears** (admin vs. end-user facing), glossary terms, style rules. |
| D9 | QA validation | **Blocking, with per-string exception override.** Placeholder / HTML / plural mismatches block approval; the owner may mark a specific string as a deliberate exception, with a recorded reason. |
| D10 | Language scope | **`tr_TR` only.** No multi-locale abstraction. |
| D11 | Glossary conflict on re-sync | **Newest wins** — see O1 for the one tension to resolve. |
| D12 | Style guide | **A general Turkish style guide plus per-domain-tag rules**, editable in the panel, injected into every AI request. |
| D13 | Users / auth | **None.** Single user, local. No login, registration, roles or multi-tenancy. |
| D14 | Docs language | **English.** |
| D15 | Stack | **Deferred to Phase 2** → `adr/0001-tech-stack.md`. |
| D16 | AI provider | **Deferred to Phase 2** → `adr/0002-ai-provider.md`. |

---

## 5. Findings that constrain the design

**R1 — PO is required on import; JSON is not sufficient.**
D8 needs to know whether a string appears in the admin or in front of the end user. That lives in the PO file's `#:` source references (e.g. `#: includes/admin/class-settings.php:42`) and `#.` extractor comments. The GlotPress **JSON / Jed** export drops both and encodes context inside the key as `ctx\u0004msgid`. Therefore: **import PO**, and keep `#:` and `#.` in the data model.

**R2 — `msgctxt` must still survive the round trip.**
D5 rightly excludes `msgctxt` from *matching*, but it must be preserved verbatim on export or the PO will not re-import cleanly into GlotPress. Local evidence: `wc-sanal-pos-tr_TR.po` has **0** `msgctxt`, while WP core `tr_TR.po` has **959** and `admin-tr_TR.po` has **180**. Fixtures must cover both shapes.

**R3 — Plural forms.**
Turkish is `nplurals=2; plural=(n > 1);`. The data model must handle `msgid_plural` / `msgstr[0]` / `msgstr[1]`, and QA (D9) must validate plural arity.

**R4 — Environment** (verified 2026-09-22).
PHP 8.5.10 + Composer 2.10.3 — extensions present: `pdo_sqlite`, `sqlite3`, `gettext`, `mbstring`, `curl`, `zip`, `openssl`, `pdo_mysql`, `pdo_pgsql`.
Node 24.18.0 + npm 11.16.0. Go. MariaDB 11.8.8. Docker 29.7.2 / Podman 5.8.7. WP-CLI 2.12.0. git 2.55.0.
**The PHP `intl` extension is NOT installed** — relevant if the stack turns out to be PHP and locale or collation handling is needed. The `sqlite3` **CLI binary** is also absent, though the PHP driver is present.

**R5 — Local corpus available as test fixtures.**
`~/Projects/investakademi/app/languages/` holds a full WP core `tr_TR` set:

| File | msgid | msgctxt |
|------|------:|--------:|
| `tr_TR.po` | 4 812 | 959 |
| `admin-tr_TR.po` | 3 520 | 180 |
| `admin-network-tr_TR.po` | 325 | 21 |
| `continents-cities-tr_TR.po` | 529 | 0 |

≈ 9 200 human-reviewed entries, plus 40 further `.po` files across the owner's own projects. Per D3 these are **not** auto-ingested, but they are ideal fixtures.

---

## 6. Open questions

Carried forward; each must be resolved in the phase named.

| # | Question | Resolve in |
|---|----------|-----------|
| O1 | **D7 vs. D11 conflict.** D7 writes the owner's approved translations into the glossary; D11 says a re-synced external source overwrites with the newest value. As written, a sync can silently overwrite a translation the owner personally approved. Does "newest wins" apply to *all* entries, or only to externally-sourced ones? | Phase 1 |
| O2 | Are the translate.wordpress.org export URL patterns and rate limits as assumed? **Must be fetched and inspected once**, not assumed. | Phase 2 |
| O3 | What exactly identifies "admin vs. end-user facing" from `#:` paths? Heuristics must be defined and tested against real plugins. | Phase 1 (rule), Phase 2 (implementation) |
| O4 | Is the domain tag single- or multi-valued per project, and can an individual *string* override its project's tag? | Phase 1 |
| O5 | ~~`git init` for this repository.~~ **Resolved 2026-09-22: repository initialised in Phase 0.** | ✅ Closed |
| O6 | The selected option was labelled "manual upload", but the description given covers only a curated URL list. Is uploading a `.po`/`.pot` file into the glossary *also* wanted? It would be the only way to ingest the R5 corpus. | Phase 1 |
| O7 | How is the **target** project ingested — does the owner download the export and hand the file over, or does the tool fetch it by URL (as curated sources already are)? | Phase 1 |
| O8 | Is the domain tag taxonomy a **closed set** or an **open vocabulary**? D6 settles only *who* assigns tags (AI proposes, owner confirms), not the shape of the vocabulary. A closed set blocks synonym drift that would break matching; an open one is more flexible. | Phase 1 |

---

## 7. Skill activation per phase

| Phase | Skills |
|-------|--------|
| 0 — Planning | `wordpress` *(loaded; plugin/theme-development oriented, so it pays off mainly in Phase 4)* |
| 1 — Business logic | `product-management:brainstorm` / `product-management:product-brainstorming` for the discussion, then `product-management:write-spec` for the goals / non-goals / acceptance-criteria structure |
| 2 — Architecture | `engineering:system-design`, `sql-expert`, `engineering:architecture` (ADR format), `claude-api` *(only if ADR-0002 selects Claude)* |
| 3 — Web UI | `design:design-system`, `design:ux-copy`, `design:accessibility-review` |
| 4 — Implementation | `code-standards` throughout, then stack-dependent: `laravel` / `php` / `phpunit`, or `javascript` / `vuejs` / `react`, or `golang` / `golang-tester`; `docker` if containerised |

Deliberately **not** used: `architecture-advisor` (audits an existing codebase — this one started empty), and the Claude Docs connector / `anthropic-skills:docs` (these documents are local files by request).
