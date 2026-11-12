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
   term list. Their order is yours — drag a row by its handle or move it with the
   arrow keys — and it is what settles a disagreement: the higher source wins.
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
   be translated again. A row names the check that blocks it, and a check that is
   wrong about that string can be skipped against a reason you type: the string is
   saved again and checked without it. Characters with no appearance — the spaces
   that matter, tabs, line breaks, anything else invisible — are drawn as markers
   with a legend, because what the checks compare at a string's edges is what the
   eye cannot find. **Find and replace** works on translations only, literally
   and with case respected, across whatever the filter and search currently
   select — not the page in front of you. It counts first and asks before writing,
   and what it rewrites returns to review, because the approved text is no longer
   the text.
7. **Export.** Only approved strings, as a PO GlotPress will import cleanly. The
   panel says how many went in and how many stayed behind, and will not hand you a
   file with nothing in it — a project nobody has approved yet exports nothing, by
   design.

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

You can also write entries by hand on the glossary screen, and remove them.
Yours are marked as yours and a source update never deletes them. Only yours can
be removed: an entry a trusted source still carries, or a term from the official
WordPress glossary, would be written back at the next update, so removal is
refused rather than undone behind you. To be rid of one of those, drop its
source.

## Running

```bash
pnpm install
pnpm run build:panel
pnpm run serve            # http://127.0.0.1:4173
```

Requires Node.js >= 22 (for `node --experimental-strip-types`). `WPT_DB` sets the
database path (default `wp-translator.sqlite`), `WPT_PORT` the port, `WPT_PANEL`
the built panel it serves (default `dist/panel`). Panel development:
`pnpm run dev:panel`, which proxies `/api` to the server.

A fresh database already carries the trusted sources and the Turkish style guide
— nothing to paste in. The official WordPress Turkish glossary is not seeded,
because it needs a network fetch: press **Tümünü güncelle** on the
trusted-sources screen once and it arrives along with every source.

**Splitting the tag is your call.** Everything starts under one `wordpress` tag.
Giving WooCommerce its own tag is what makes `item` come out as `ürün` there and
`öge` elsewhere; until that split exists the two senses share a tag and the
source ranking decides.

## Setting up a CLI

The tool drives a coding CLI, and the panel and the review script each let you
pick which: **opencode**, or **agy** — the Antigravity CLI. opencode is the one
that has to be configured; agy is only told a model.

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

**Do not rely on a free model.** The roster rotates and they refuse CLI requests
without warning — *"OpenCode's free tier can only be used from within
OpenCode"*, HTTP 403. opencode's own default is one of them, so leaving the model
unset is exactly what breaks. Name a model from a plan you have; the panel asks
for `zai-coding-plan/glm-5.3-flash`. `opencode models` lists what is available.

The refusal arrives as an error event on opencode's **stdout** with stderr empty,
so the exit code alone says nothing. The tool reads it out and reports the
sentence; the run modal names the CLI and model it is using, so a run's output
can be told from the engine you picked.

**agy** is the other choice, and needs no agent of its own: it is asked with
`--json-schema` and hands its answer back already parsed, so nothing has to be
scraped out of prose. Its models carry the effort in their id and `--effort`
against one of those is refused, so what you choose is the model — the panel asks
for `gemini-3.8-flash-low`.

## Reviewing other people's translations

As a GTE you also approve or reject what other people submit, and the queues run
to hundreds of strings. `userscript/wp-translator-review.user.js` puts this tool's
judgement on the page you are looking at: it judges the rows GlotPress has
rendered, in batches, and does nothing with the pages you have not opened. How
many rows a page holds is your own GlotPress setting and the script does not care
what it is.

Install it in Tampermonkey or Violentmonkey and open a project with a pending
filter — `waiting`, `fuzzy`, `untranslated` or `either`. A panel appears with two
buttons.

What happens to a row depends on what the row has, not on which queue it came
from, because `fuzzy` and `either` hold both kinds:

- **It carries somebody's wording** — `waiting`, or `fuzzy` with text. The wording
  is judged: approved, ticked, or annotated with what is wrong with it.
- **It carries none** — `untranslated`, or `fuzzy` left empty. There is nothing to
  judge, so the tool translates it instead and offers the wording to apply. The
  glossary answers first where it holds exactly one translation of that string,
  then what the model has already been asked, then the model. The note says which,
  because a glossary answer was approved by a human and a model's was not.

**In Edge and Chrome the extension needs developer mode.** Turn it on at
`edge://extensions` (or `chrome://extensions`) and reload the page; without it
userscripts are never executed and the dashboard reports the script as having
never run. **No panel at all means this**, not a broken script.

Everything the panel puts in its one status line also goes to the console, prefixed
`[wp-translator]`: whether the script loaded, which filter it found, how many rows
it read, and why it will not act if it will not. If the panel is there but pressing
does nothing, that line says why — and if something on the page is sitting over the
buttons and taking the clicks, the console names the element.

- **Bu sayfayı değerlendir** — decides nothing, writes a verdict beside every row.
  On a page with no pending filter this reads **Bekleyen kuyruğuna git** and takes
  you to one instead.
- **Değerlendir ve birebir olanları onayla** — approves the ones the glossary
  already holds with that exact wording, and ticks the rest for GlotPress's own
  bulk approve.

Pressing either again re-judges the page and replaces the notes rather than adding
a second set. A verdict the model has given before is served from `ai_memory`, so
going back to a page you have already looked at costs nothing.

Three batches are asked about at once, and each row is annotated as its own answer
arrives, so the page fills in while the rest is still out. If the model stops
answering, two batches of silence end the run and the panel says how many rows
were left unasked rather than spending the timeout again on each.

Nothing is ever rejected automatically. A translation that fails a quality check
or that the model objects to is annotated with the reason and the wording the
model would have used. Rejecting is GlotPress's own button, beside the row.

Where a wording passes the quality checks it is a **button**: clicking it writes it
into the row's translation fields and saves it. A plural string is filled form by
form, so both go together or neither is offered. A list of the glossary's
alternatives is never offered as a button, because choosing between them is not
the script's to do. Saving as a GTE makes it the current translation and marks any
submission it replaces `old`, which is what correcting a short mistake in place
should do. Rejecting is for the ones worth sending back.

**The panel has a dropdown for which CLI to use** — opencode or agy — and remembers
it. Both judging and proposing go through the one you pick. It is a choice rather
than a constant because a CLI that is out of quota does not fail, it hangs, and
from the page there is no way to tell which one that is. What each name means —
which model, which agent — is the `ENGINES` block at the top of the script.

The local server must be running. The script reaches it through
`GM_xmlhttpRequest`, so the server needs no CORS of its own and nothing else on
the page can talk to it.

The panel checks that before you press anything — it asks `/api/health`, which
touches neither the database nor a model — and says `hazır değil` with the reason
if it cannot.

**`background shutdown` in that message is the extension, not the server.** Chrome
puts an extension's background worker to sleep and it carries every request the
script makes, so one can die with the worker. Nothing is held open for it to die
during: judging and proposing hand back a ticket the script polls, each request
taking milliseconds, and a poll that is lost finds the answer waiting. A request
dropped outright is sent again. **A new script version makes the extension ask for its connection
permission again**, and a dismissed prompt reads exactly like a server that is not
running, so the message names both.

Judging goes through whichever CLI you picked: agy is given the schema and hands
the verdicts back parsed, opencode cannot be told a shape so its text is scraped
for the array. A row the model cannot be asked about is annotated with the reason
and left alone, so a configuration problem shows up on the page instead of
stopping the run.

## Settling what the memory already answers

A pending queue carries rows that need no judgement, because GlotPress's own
translation memory already answers them: it holds a 100% match for the source
string, and the only question is whether the submitted wording is that one.
`userscript/wp-translator-tm-approve.user.js` walks the plugins with something
pending and settles exactly those rows. It needs no local server and asks no
model — it reads the suggestions GlotPress loads into the row and presses
GlotPress's own buttons, so it has the rights your session has and no others.

Three things can happen to a row, and the memory decides which:

- **The wordings are identical** — the row is **approved**.
- **The memory answers with a different wording** — that wording is **saved**,
  which as a GTE makes it the current translation and keeps the submission in the
  history. Where the memory offers several at 100% the first is taken, because
  that is the one GlotPress itself puts at the top.
- **The plugin has no code project at all** — its page carries *This plugin is not
  properly prepared for localization*, which
  `wporg-gp-customizations/templates/locale-project.php` renders when the project
  has neither a `dev` nor a `stable` sub-project. Nothing translated there can ever
  ship, so every pending row is **rejected**, memory or no memory, and the walk
  takes every sub-project with something pending rather than the usual two. The
  sentence and the sub-project list say the same thing, and the console says so
  when they disagree.

Install it alongside the review script and open
`/locale/tr/default/wp-plugins/?filter=strings-waiting-and-fuzzy-asc`. A second
panel appears with **Kuru gezinti**, which writes beside every row what would
happen to it and touches nothing, and **Gez ve uygula**, which does it. A dry run
is bounded to the first couple of listing pages — `DRY_LIST_PAGES` at the top of
the script — because what it is there to show is that the memory answers and that
the comparison picks the right rows, and the first plugins say that. A live run
takes the whole plugin list before it writes anything, because that listing is
sorted by what is pending and every write moves a plugin in it — following its
paging live would walk past whatever crossed a page boundary meanwhile.

Per plugin it works **Development and Development Readme** where there is a
development project, and Stable and its readme where there is not, taking the
`waiting` and `fuzzy` queue URLs from the plugin page's own table so a sub-project
with nothing pending costs no page load. It pages with GlotPress's own `next`, and
works a page again when it wrote something there: a settled row leaves the queue
and pulls the next page's rows onto this one.

What it will act on is narrow on purpose:

- **The score has to be 100%.** That number is the similarity of the *source*
  string, so a 95% suggestion is a translation of a different English string and
  says nothing about this one.
- **Identical means identical**, with no folding of case or edge whitespace. The
  memory holds `Geri yükle`, `Geri Yükle` and `Geri Yükleme` as separate answers
  for one string, and a trailing space is exactly what GlotPress's own checks are
  watching — so a wording that differs by either is a wording to save, not one to
  approve.
- **Plural rows are skipped**, where the memory is what decides. It answers the
  singular, and settling a plural row off its singular half settles a form nobody
  looked at. A rejection does not read the wording, so an unlocalisable plugin's
  plural rows go with the rest.
- **Pressing is not doing.** The row's status is what says it happened; a press
  that leaves the row where it was is counted and annotated, not reported as a
  write. A save makes a *new* translation, so the row comes back under a new id and
  the status is watched by the original's id rather than the row's. A row whose
  write did not take is left alone for the rest of that queue: a save GlotPress
  stored as `waiting` would otherwise be saved again on every pass over the page.
- **A refusal is read, not waited out.** The request belongs to the page, so the
  script wraps `XMLHttpRequest` and `fetch` — which it can because it is granted
  nothing and runs in the page's own context — and matches the answer to the row by
  the id in the request body. A non-200, or a 200 whose body says `success: false`,
  ends the wait at once and the row carries the reason. Success is still the row's
  status: what a 200 means is GlotPress's business and not something to guess. Where
  the wrapping does not take, the walk waits for the status as before and the console
  says so on load.
- **Rejection is the row's own inline button and nothing else.**
  `gp-translation-helpers/js/reject-feedback.js` puts a feedback modal in front of
  the *bulk* reject, and the editor's reject button sits inside that feedback form,
  so pressing either would wait on a dialog nobody is going to fill.
- **A pending row with no wording at all** — a `fuzzy` entry left empty — gets the
  memory's wording saved, because there is nothing to compare and nothing to lose.

A row the script decided about is coloured as well as annotated — approve, save,
reject, and a press that did not take each get their own colour — and
both of the string's rows carry it, the queue's and the one opening it left behind,
because which of them you are looking at is your own doing.

Each source string is asked about once and the answer is kept in the browser, so
the `Delete` three plugins later costs nothing. **The completion-tier walk shares
that cache**, because it reads the same suggestions out of the same container and
keeps the same 100% filter — so whichever of the two sees a string first pays for
it. **Önbelleği temizle** empties it for both. The run itself lives in the tab
doing it, so another translate.wordpress.org tab is left alone, and it picks up
where it left off if the tab reloads. **Durdur** ends it.

## Spending the work where it can ship

A locale is shown in a plugin once its translation reaches 90%. Three good
suggestions on a project at 5% therefore change nothing at all, and checking them
by hand costs exactly what checking the ones that matter costs.
`userscript/wp-translator-tier-run.user.js` asks each sub-project one question
before it reads a single row: **if every waiting and fuzzy row in it were settled,
what would it reach?** The answer decides what happens to the rows.

- **75% or more** — within reach of shipping, so it is yours to look at. The
  sub-project is listed and its rows are left alone. **Elle listesi** copies the
  list; it survives resetting the run, because it is the only thing the run
  produces that nothing else records.
- **25% to 74%** — worth closing. GlotPress's own memory settles what it answers
  at 100%, exactly as the memory walk does: identical is approved, different is
  saved. What it does not answer goes to the local server with the source, the
  `msgctxt` and the submitted wording — the glossary and the quality checks there
  settle what they can before any model is asked. The tool agreeing approves the
  row; the tool offering another wording saves that instead, but only a wording
  the checks have already accepted. Anything else is annotated and left.
- **Under 25%** — out of reach whatever is done to the queue, so every waiting and
  fuzzy row is rejected, plural rows included.

The projection is not the size of the queue. GlotPress counts originals in `All`
and translations in the status columns, so a string that already has a current
translation *and* a pending suggestion is counted in two of them — and approving
that row replaces a translation that was already current, moving the percentage by
nothing. What it is:

```
projected = ceil((All - Untranslated - Changes requested) / All * 100)
```

Those four numbers come from the filter bar of the page the rows are on, which
carries the set's counts whether or not a filter is applied.

Which sub-projects get walked is decided the same way — by where the rows are.
A plugin has up to four, in two pairs: the code project and its readme, each in a
development and a released copy. The walk takes **one out of each pair, whichever
has more pending**, and a tie goes to development. Taking development because it
exists is what skips the work: a queue sits in whichever set its submissions were
made against, so a development project that is in step beside a released one that
is not means walking past every pending row the plugin has. Where both hold rows
they hold the same submissions, so the larger queue is the fuller copy of the work
rather than more of it. The percentages the
site itself prints are not used: they come from cached counters on the translation
set and disagree with the live counts in both directions.

Install it alongside the other two and open
`/locale/tr/default/wp-plugins/?filter=strings-waiting-and-fuzzy-asc`. **Deneme**
writes beside every row what would happen and presses nothing. It still asks the
memory and the model, so it is bounded to the first couple of listing pages —
`DRY_LIST_PAGES` at the top of the script — because what it is there to show is
that the bands land where they should, and the first plugins say that; what it
asks the model is remembered for the live run either way. **Çalıştır** does it. The listing
runs to dozens of pages and its last ones carry thousands of rows each, so the run
is long by nature: it keeps where it was outside the tab, **Durdur** ends it with
that kept, and **Devam** picks it up. What it asks GlotPress's memory goes into the
same cache the memory-approval walk fills, so the two never pay for one string
twice. A provider that cannot be reached stops the
run by itself — the server says so as a field rather than as a verdict, because a
CLI that is out of quota hangs rather than failing, and the glossary settles rows
in the same batch it would otherwise hide behind.

It reaches the server from the page's own context, so `/api/*` answers
`https://translate.wordpress.org` and nothing else. In Chrome a page calling
127.0.0.1 is a private-network request the browser decides about before the server
sees it; the preflight grants it, and a refusal there leaves no trace in the
server's log.

## Updating the style guide in an existing database

The guide is seeded once, on first open, so a database created before an edit to
`style-guide/tr-genel.md` keeps the older text. Re-seeding on every open would
overwrite whatever has since been written in the panel.

```bash
pnpm run style-guide:sync            # replaces the general guide with the file
pnpm run style-guide:sync -- --force # …even if it was edited by hand
```

Without `--force` it refuses when the stored text carries lines the file does
not, and prints them — that is the signature of a hand edit.

## Layout

| | |
|---|---|
| `src/po/` | PO parse and serialise |
| `src/db/` | schema, forward-only migrations, the folding SQLite needs |
| `src/glossary/` | trusted-source sync, matching, terminology, the official term list |
| `src/project/` | importing a project and exporting its PO |
| `src/quality/` | the blocking checks |
| `src/translate/` | the provider interface, and opencode and agy behind it |
| `src/wporg/` | translate.wordpress.org and wordpress.org access |
| `src/server/` | HTTP API and the panel's back end |
| `src/cli/` | the two entry points: the server and the style-guide sync |
| `panel/` | Vue 3 panel |
| `src/judge/` | judging somebody else's translation |
| `src/ai/` | what the model has already been asked |
| `src/text/` | the whitespace a stored word is put back into |
| `style-guide/` | the Turkish style guide seeded into new databases |
| `userscript/` | the three translate.wordpress.org walks: review, memory approval, completion tiers |

## Tests

```bash
pnpm test
pnpm run typecheck
pnpm exec vue-tsc --noEmit -p tsconfig.json
pnpm run build:panel
```

They assert the properties the design argued for rather than the happy path: PO
round-trip keyed by GlotPress's own identity, an entry surviving when a second
source still carries it, two disagreeing sources giving the same answer whichever
order they sync in, a translation refused by the checks staying out of a bulk
approve, and a project's work never reaching the glossary.

`AGENTS.md` is the other half of the documentation: why the code is shaped the
way it is, and what will bite you if you change it.
