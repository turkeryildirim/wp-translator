# wp-translator

Translates untranslated WordPress plugins and themes into Turkish with AI help,
kept consistent by grounding the model in translations humans have already made,
reviewed and approved on translate.wordpress.org.

Single user, runs locally. The output is a **PO file** you import into GlotPress
with your GTE rights.

## Why not GlotPress

It carries a lot of functionality this workflow never touches, it offers no
personal glossary, and it cannot run AI translation.

## How it works

1. **Trusted sources.** A curated list of translate.wordpress.org projects whose
   Turkish translations are known to be good. Their PO exports are fetched and
   imported into a local glossary, along with the WordPress Turkish team's own
   term list.
2. **A project to translate.** Added by its translate.wordpress.org URL. Its
   catalogue is fetched, and for plugins and themes its wordpress.org metadata
   comes too.
3. **What the service already has.** The export arrives with its translations,
   so a project shows what is done, what is not, and what fails a quality check
   — `meta/wordcamp` is 2 413 translated against 703 untranslated, not 3 116
   untranslated.
4. **Glossary match.** Strings translated before are filled in automatically and
   count as done.
5. **AI for the rest.** Everything left goes to the model in JSON batches, each
   carrying the glossary terms that appear in it and the Turkish style guide.
6. **Review.** Every AI translation waits for you, in a paged queue filtered by
   what you are looking for. Approve, or edit and approve — editing *is*
   rejecting.
7. **Export.** Only approved strings, as a PO GlotPress will import cleanly.

### What the glossary is actually for

Exact full-string reuse covers about a tenth of a project — 11.8 % of Contact
Form 7, 7.8 % of Astra, measured. The other nine tenths are strings nobody has
translated before, and consistency there comes from **terminology**: 70–100 % of
a project's strings contain at least one term the glossary knows, three to six
on average, and most of those carry a term with more than one known translation.
That is the `item → ürün` in an e-commerce plugin, `öge` elsewhere problem, and
handing the model those terms is what solves it.

## Running

```bash
npm install
npm run build:panel
npm run serve            # http://127.0.0.1:4173
```

`WPT_DB` sets the database path (default `wp-translator.sqlite`), `WPT_PORT` the
port. Panel development: `npm run dev:panel`, which proxies `/api` to the server.

A fresh database already carries 41 trusted sources and the Turkish style guide.
Press **Güncelle** on the trusted-sources screen once to download the glossary:
about 49 500 entries, half a minute.

opencode needs one-time setup — a provider and a tool-free agent. See
[`docs/setup.md`](docs/setup.md).

## Layout

| | |
|---|---|
| `src/po/` | PO parse and serialise |
| `src/glossary/` | trusted-source sync, matching, terminology, the official term list |
| `src/project/` | importing a project and exporting its PO |
| `src/quality/` | the blocking checks |
| `src/translate/` | the provider interface and its opencode implementation |
| `src/wporg/` | translate.wordpress.org and wordpress.org access |
| `src/server/` | HTTP API and the panel's back end |
| `panel/` | Vue 3 panel |
| `docs/` | the design, phase by phase |
| `style-guide/` | the Turkish style guide seeded into new databases |

## Design

`docs/00-process.md` is the register: 45 numbered decisions and 32 constraints,
most of them measured rather than reasoned. A few that shaped the code:

- **Matching is byte-exact.** Lowercasing would gain 253 matches across
  WooCommerce's 14 159 distinct sources, but 197 of them map to a *different*
  translation — `Saved for Later` is `Sonraya Kaydet`, `Saved for later` is
  `Sonraya kaydedildi`. Normalising is a net loss, and nothing malformed exists
  for the checks to catch.
- **A project's `msgctxt` is carried but never read.** GlotPress matches an
  imported entry by singular + plural + context, so an export that drops it
  loses those translations. Classic Editor has 8 in 54 strings. The *glossary*
  is a different matter: context was part of its key until it was measured, and
  over three real plugins it decided none of the 281 matches it could have.
- **Several sources vouch for one entry.** WooCommerce and WordPress core share
  643; across all 41 sources, 5 511. A single owner column cannot express that,
  so sources link to entries and an entry goes only when the last link does.
- **The quality checks compare counts, never positions.** Turkish word order
  moves placeholders and the tags around them; that is what `%1$s` is for.

## Tests

```bash
npm test            # 221 tests
npm run typecheck   # tsc
npx vue-tsc --noEmit -p tsconfig.json
```

They assert the properties the design argued for rather than the happy path: PO
round-trip keyed by GlotPress's own identity, an entry surviving when a second
source still carries it, two disagreeing sources giving the same answer whichever
order they sync in, and a translation refused by the checks staying out of a bulk
approve.
