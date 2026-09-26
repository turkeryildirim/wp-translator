# Working in this repository

Read `README.md` for what the tool does and how to run it. This file is about
how to change it.

## Measure before deciding

This is the repository's habit, and most of its design came from it. Several
decisions went the *opposite* way from the obvious guess, and only because
someone checked:

- Normalising before matching looked obviously right. Most of the matches it
  gains map to a *different* translation.
- Keying the glossary on `msgctxt` looked like precision. Across real plugins it
  decided none of the matches it could have.
- Path heuristics for "is this an admin string" looked solid. They decide about
  half of one large plugin and a fifth of another.

So: before changing behaviour, check it against real data. The catalogues are a
`curl` away and `data/trusted-sources.txt` lists them. Put what you found in the
commit message — that is where the history lives.

## The build constraint

**The tool runs straight from source** — `node --experimental-strip-types`, no
build step. That rules out TypeScript syntax that emits code:

- no constructor parameter properties (`constructor(private readonly x: T)`)
- no `enum`, `namespace`, or decorators
- imports of `.ts` files keep the extension

`tsconfig.json` has `allowImportingTsExtensions`. The panel is the exception: it
goes through Vite.

## Checks

```bash
npm test                              # vitest
npm run typecheck                     # tsc --noEmit
npx vue-tsc --noEmit -p tsconfig.json # includes the .vue files
npx vite build                        # the panel
```

`vite.config.ts` sets `root: 'panel'` for the UI build, which is why tests have
their own `vitest.config.ts`. Do not merge them.

## Tests

Assert the property the design argued for, not that the function runs. A good
test names the failure it prevents:

```ts
it('keeps the two entries whose msgid is the string "0"', () => {
  // A truthiness check drops these, because "0" is falsy.
```

Fixtures live in `test/fixtures/`. `edge-cases.po` carries the cases that break
naive parsers — `msgid "0"`, `msgctxt`, plurals, significant trailing whitespace,
escaped quotes. Add to it rather than inventing a new fixture.

Some tests assert a **query plan** or a **time budget** rather than a result
(`test/sync-plan.test.ts`, `test/glossary-paging.test.ts`), and some assert the
**shape of a component** (`test/review-table.test.ts`). Those guard failures that
are invisible in behaviour: the answer stays correct while the server stops
answering, or the list quietly drifts a row out. Keep them.

## Documentation and comments

`README.md` and this file are the documentation. Both are present-tense
descriptions of how things are: **no history, no changelog, no record of
completed work, and no statistics**. Git holds the history, and a figure written
into a document is a claim that goes stale silently — the panel gets its numbers
from the database for the same reason.

Code comments say what something is for where the code cannot, in two or three
sentences at most, plus parameters and annotations where they help. They are not
the place for how the code got here or for what a measurement showed.

Commit messages carry all of that. Say what changed and why, and give the
measurement if one drove it.

## Things that will bite

- **`opencode run --format json` hangs unless stdin is closed.** Undocumented.
  Symptom is zero bytes and no error. This is why `src/translate/opencode.ts`
  uses `spawn` with `stdio: ['ignore', …]` rather than `execFile`.
- **A model can answer a batch by reaching for a shell.** agy exits zero, reports
  `SUCCESS` with an empty `response`, no `structured_output`, and the only trace
  is `denied_actions: [RunCommand]` — the turn was spent on a tool call that was
  refused. Both prompts carry `NO_TOOLS` (`src/translate/prompt.ts`) to stop it,
  and never describe the payload as an attached file: only opencode attaches it,
  and naming a file that is not there is what invites the read. Keep the error
  message in `agyItems` naming the denied tool; read as "ignored the schema" it
  sends you looking at the payload instead of at the model.
- **A provider failure must not fail a judging batch.** The checks and the
  glossary have already settled rows by then, and the userscript walks dozens of
  pages. `askModel` turns an unreachable model into `unknown` carrying the error
  as its reason, and rethrows only when the run was aborted.
- **Never pin an opencode model.** The free roster rotates; a model that answered
  yesterday starts returning "the free tier can only be used from within
  OpenCode". Leave it unset so opencode's default is used.
- **translate.wordpress.org rate-limits a tight loop.** No `Retry-After`, no
  headers — a run of sequential requests eventually returns 429 and the same URL
  succeeds seconds later. `src/wporg/fetch.ts` paces and retries; keep it.
- **A 404 from translate.wordpress.org is a large HTML page.** Check the status
  and content type, never the byte count.
- **translate.wordpress.org replaces GlotPress's editor row.** Read
  `wporg-gp-customizations/templates/translation-row-editor.php` in
  `WordPress/wordpress.org`, not GlotPress core, for anything inside
  `tr.editor` — the save button is `button.translation-actions__save`, not
  GlotPress's `button.ok`. The preview row and the status buttons keep their core
  classes. Nothing in there can be checked without a logged-in session: an
  anonymous fetch renders no `data-nonce` button at all, so a selector that
  "matches the template" is not a selector that has been verified.
  `userscript/wp-translator-review.user.js` accepts both spellings and logs the
  editor row when it finds neither.
- **A translation's status is not in the PO.** GlotPress states it through an
  export filter, so one request cannot separate `fuzzy` or `waiting` from
  `current`. It need not: a fuzzy entry comes through the unfiltered export with
  an empty `msgstr` and is simply redone. Do not add a request per status
  without measuring that it buys something.
- **Nothing in a project writes to the glossary.** Not an approval, not an edit,
  not the model's output. What writes to `glossary_entries` is
  `src/glossary/sync.ts`, `src/glossary/officialGlossary.ts`, and the owner's own
  hand through `createEntry`, `updateEntry` and `deleteEntry`. A glossary match is
  placed without review precisely because a human approved it upstream; a
  project's own output has not been through that.
  `test/glossary-writers.test.ts` asserts it.
- **Surrounding whitespace is shape, not meaning.** The glossary and the AI
  memory store the words alone, and the shape is restored from whichever string
  is being filled — `src/text/whitespace.ts`. The fold is `\s`, which is
  deliberate: it is exactly the set the quality checks compare at a string's
  edges, so anything folded is still guarded. Zero-width format characters are
  outside it — `\s` does not match them and neither do the checks, so folding
  them would hide a difference nothing is watching. Punctuation is outside it
  because it changes what a string says.
- **A glossary entry is a source *and a translation*.** `msgctxt` is not part of
  the key and matching never reads it; it lives in `glossary_entry_contexts` as
  a note. Two wordings of one string are two rows, and matching ranks them. Do
  not reintroduce a "winning" translation on the entry — storing one is what hid
  the alternatives.
- **Nothing rewrites `translation` on a synced entry.** It is part of the key,
  so an edit makes the row the owner's (`origin = 'owner'`) — otherwise it
  matches no source's wording, loses its vouches and the sweep deletes it.
- **`glossary_entries` holds two kinds of row.** Translation memory has
  `pos IS NULL`; terminology has `pos IS NOT NULL` and keys on the translation
  too, because the official glossary offers alternatives under one part of
  speech. Separate partial unique indexes. Matching uses memory rows only.
- **`blocked` on a unit is stored, not derived.** The review queue filters and
  pages on it in SQL, and recomputing the checks per row is what forces the
  screen to load a whole catalogue. Anything that writes `msgstr` writes
  `blocked` too — `saveUnit`, `applyGlossary`, `replaceUnits`, and the AI writer.
- **Counts in a select list are paid per sorted row, not per returned row.** A
  page query that sorts before it limits evaluates them for everything it sorts.
  Choose the page's ids in a CTE and decorate only those.
- **A scan in `sync.ts` hangs the whole server, it does not merely slow it.**
  `better-sqlite3` is synchronous, so a statement that loses its index blocks
  the HTTP loop — the panel cannot even poll its own progress. An `OR` across
  two different index lookups is the way to lose it; write two seeks joined by
  `coalesce`, and spell `msgctxt IS NULL` as `ifnull(msgctxt, '') = ''` because
  that is what `idx_glossary_memory_key` is built on. `test/sync-plan.test.ts`
  asserts the plan.
- **SQLite `NOCASE` and `LIKE` fold ASCII only.** `içerik` and `İÇERİK` compare
  unequal, so tag names and both search boxes fold in the application instead —
  `src/db/fold.ts`, registered as the SQLite function `fold` in `openDb`. It
  collapses all four i-forms rather than applying Turkish casing, because the
  source column is English and `item` has to find `ITEM`.
- **The style guide is seeded once**, from `style-guide/tr-genel.md`, on a
  database's first open. Editing the file does not reach existing databases —
  `npm run style-guide:sync` does that, and refuses when the stored text looks
  hand-edited.
- **The quality checks and the AI prompt must agree.** The checks allow a
  translated `title` and any ordering; the prompt has to say so, or the model
  produces English tooltips the checks then bless. A test asserts the prompt
  carries both rules.
- **Nothing that can grow belongs inside a review row.** Editing happens in the
  detail panel. The queue is a table and stays one.

## The rules behind the shapes

Not measurements, just decisions that the code assumes everywhere.

- **Single user, local, no auth.** The server binds to 127.0.0.1.
- **The sync runs unattended.** Entries are updated, added and removed without
  confirmation. The owner supplies the list and presses the button.
- **Only `current` translations feed the glossary.** `waiting` is unreviewed and
  would dilute it.
- **The status model.** A glossary match is placed as `ok` without review,
  because a human approved it upstream. AI output is `review`; approval makes it
  `ok`. Rejection is not a state — it clears the translation and the unit
  returns to `untranslated`.
- **`msgctxt` on a project's units is carried verbatim and never matched on.**
  GlotPress identifies an entry by singular + plural + context, so an export
  that drops it loses those translations.
- **The style guide is free text**, written by the owner and passed to the model
  whole. General rules plus per-tag rules. No structured editor.
- **Tag drift is prevented and repaired**: the model is given the existing tag
  list and told to choose from it, and the panel offers a merge that moves every
  entry and project from one tag to another.
- **`dev` where a project has one, otherwise `stable`.** A slug alone cannot
  identify a project, so the owner supplies the full URL.

## Schema changes

Forward-only migrations in `src/db/migrations.ts`, each with `PRAGMA
user_version` moved to match. `schema.sql` is version 1 and is not edited again —
a database created months ago and one created today must end up identical, not
merely similar. A migration's SQL is frozen once it has shipped, even when a
later one subsumes it.
