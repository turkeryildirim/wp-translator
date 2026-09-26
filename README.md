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
   so a project shows what is done, what is not, and what fails a quality check.
   Most of a mature project is already translated, and those strings are what a
   GTE is reviewing.
4. **Glossary match.** Strings translated before are filled in automatically and
   count as done. Where the glossary knows several translations of one string
   the best-supported is used, and the rest stay one keystroke away.
5. **AI for the rest.** Everything left goes to the model in JSON batches, each
   carrying the glossary terms that appear in it and the Turkish style guide. A
   run can be aimed at the untranslated strings, the ones awaiting approval, the
   rows you picked, or the whole catalogue from scratch.
6. **Review.** A paged queue you filter by what you are looking for. Approve,
   edit and approve, or reject — which empties the string and sends it back to
   be translated again.
7. **Export.** Only approved strings, as a PO GlotPress will import cleanly.

### What the glossary is actually for

Exact full-string reuse covers about a tenth of a project. The other nine tenths
are strings nobody has translated before, and consistency there comes from
**terminology**: most strings contain at least one term the glossary knows, and
many of those terms have more than one known translation. That is the
`item → ürün` in an e-commerce plugin, `öge` elsewhere problem, and handing the
model those terms is what solves it.

Nothing translated in a project ever enters the glossary — not your edits, not
the model's output. The glossary holds what humans reviewed and approved
upstream, which is the whole reason a match from it can be used without review.
To get a project's work in, add it as a trusted source once it has been approved
on translate.wordpress.org.

## Running

```bash
npm install
npm run build:panel
npm run serve            # http://127.0.0.1:4173
```

`WPT_DB` sets the database path (default `wp-translator.sqlite`), `WPT_PORT` the
port. Panel development: `npm run dev:panel`, which proxies `/api` to the server.

A fresh database already carries the trusted sources and the Turkish style guide
— nothing to paste in. The official WordPress Turkish glossary is not seeded,
because it needs a network fetch: press **Güncelle** on the trusted-sources
screen once and it arrives along with every source.

**Splitting the tag is your call.** Everything starts under one `wordpress` tag.
Giving WooCommerce its own tag is what makes `item` come out as `ürün` there and
`öge` elsewhere; until that split exists the two senses share a tag and the
source ranking decides.

## Setting up opencode

The tool drives opencode, which has to be configured once.

**A provider.** `opencode auth` — any provider opencode supports.
`opencode api model.list` then shows what is available.

**A tool-free agent.** opencode is a *coding* agent: its default `build` agent
can read files, write them and run shell commands. Asked to translate, a model
may instead try to *read* the attached file with a tool. That raises a
permission request, nothing answers it because no human is watching, and the run
hangs. In `~/.config/opencode/opencode.json`:

```json
{
  "agents": {
    "wp-translator": {
      "description": "Translates JSON batches of WordPress UI strings into Turkish. Text only, no tools.",
      "mode": "primary",
      "permissions": [{ "action": "*", "resource": "*", "effect": "deny" }],
      "system": "You translate WordPress interface strings into Turkish. …"
    }
  }
}
```

Verify it:

```
opencode run --agent wp-translator "List the files here using your tools."
→ I can't list files because I don't have tool access.
```

`opencode api agent.list` returns an empty array even when the agent loads; the
run header (`> wp-translator · <model>`) is what confirms it.

**Do not pin a model.** The free roster rotates: a model that answered yesterday
can start returning *"OpenCode's free tier can only be used from within
OpenCode"*, and another appears in its place. Leave it unset so opencode's own
default is used.

## Reviewing other people's translations

As a GTE you also approve or reject what other people submit, and the queues run
to hundreds of strings paged fifteen at a time. `userscript/wp-translator-review.user.js`
puts this tool's judgement on those pages.

Install it in Tampermonkey or Violentmonkey and open a project with a pending
filter — `?filters[status]=waiting` or `fuzzy`. A panel appears with two buttons:

**In Edge and Chrome the extension needs developer mode.** Turn it on at
`edge://extensions` (or `chrome://extensions`) and reload the page; without it
userscripts are never executed and the dashboard reports the script as having
never run. The script logs `[wp-translator] yüklendi` to the console, which is
how to tell "did not run" from "ran and had nothing to do".

- **Yalnızca değerlendir** — decides nothing, writes a verdict beside every row.
- **Değerlendir ve birebir olanları onayla** — approves the ones the glossary
  already holds with that exact wording, and ticks the rest for GlotPress's own
  bulk approve.

Nothing is ever rejected automatically. A translation that fails a quality check
or that the model objects to is annotated with the reason and the wording the
model would have used; rejecting stays yours to do, because in GlotPress it
notifies the contributor.

Where that wording passes the quality checks it is a **button**: clicking it
writes it into the row's translation field and saves it. Only a single wording is
ever offered — not a list of the glossary's alternatives, and not a plural string,
where one form cannot fill the others. Saving as a GTE makes it the current
translation, which marks the submission it replaces `old` rather than `rejected`:
the contributor is not notified. Reject first if you want them to be.

The local server must be running. The script reaches it through
`GM_xmlhttpRequest`, so the server needs no CORS of its own and nothing else on
the page can talk to it.

Judging goes through **agy** rather than opencode: it needs a verdict per row and
agy's `--json-schema` is what makes that reliable. A row the model cannot be
asked about is annotated with the reason and left alone, so a configuration
problem shows up on the page instead of stopping the run.

## Updating the style guide in an existing database

The guide is seeded once, on first open, so a database created before an edit to
`style-guide/tr-genel.md` keeps the older text. Re-seeding on every open would
overwrite whatever has since been written in the panel.

```bash
npm run style-guide:sync            # replaces the general guide with the file
npm run style-guide:sync -- --force # …even if it was edited by hand
```

Without `--force` it refuses when the stored text carries lines the file does
not, and prints them — that is the signature of a hand edit.

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
| `src/judge/` | judging somebody else's translation |
| `src/ai/` | what the model has already been asked |
| `style-guide/` | the Turkish style guide seeded into new databases |
| `userscript/` | the review script for translate.wordpress.org |

## Tests

```bash
npm test
npm run typecheck
npx vue-tsc --noEmit -p tsconfig.json
npx vite build
```

They assert the properties the design argued for rather than the happy path: PO
round-trip keyed by GlotPress's own identity, an entry surviving when a second
source still carries it, two disagreeing sources giving the same answer whichever
order they sync in, a translation refused by the checks staying out of a bulk
approve, and a project's work never reaching the glossary.

`AGENTS.md` is the other half of the documentation: why the code is shaped the
way it is, and what will bite you if you change it.
