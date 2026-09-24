# Working in this repository

Read `README.md` for what the tool does. This file is about how to change it.

## Measure before deciding

This is the repository's habit, and most of its design came from it. Several
decisions here went the *opposite* way from the obvious guess, and only because
someone checked:

- Normalising before matching looked obviously right. Measured, 78 % of the
  matches it gains map to a different translation.
- The published opencode docs describe an API the installed version does not
  have, and say nothing about `--format json` hanging unless stdin is closed.
- Path heuristics for "is this an admin string" looked solid. They decide 61 %
  of WooCommerce and 20 % of Yoast.

So: before changing behaviour, check it against real data. The catalogues are a
`curl` away, and `data/trusted-sources.txt` lists 41 of them. When a measurement
contradicts an assumption, record it in `docs/00-process.md` as a numbered
constraint (`R…`) rather than fixing the code quietly.

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
```

`vite.config.ts` sets `root: 'panel'` for the UI build, which is why tests have
their own `vitest.config.ts`. Do not merge them.

## Tests

Assert the property the design argued for, not that the function runs. A good
test here names the failure it prevents:

```ts
it('keeps the two entries whose msgid is the string "0"', () => {
  // The PHP library measured for ADR-0001 drops these: "0" is falsy, so a
  // truthiness check discards the entry. This asserts we never regress into it.
```

Fixtures live in `test/fixtures/`. `edge-cases.po` carries the cases that break
naive parsers — `msgid "0"`, `msgctxt`, plurals, significant trailing whitespace,
escaped quotes. Add to it rather than inventing a new fixture.

## Documentation

`docs/` carries **no history**. No "was X, then became Y", no changelog, no record
of completed work — git holds that. Spec files (`01`, `02`, `03`) are present-tense
descriptions; `00-process.md` is the decision register and is deleted when every
phase closes.

Decisions are numbered `D…`, constraints `R…`, open questions `O…`. Reference
them from code comments where the reason is not obvious from the code:

```ts
// Matching is byte-exact on the source string — no normalisation (R13).
```

Commit messages carry the history the documents do not. Say what changed and
why, and include the measurement if one drove it.

## Things that will bite

- **`opencode run --format json` hangs unless stdin is closed.** Undocumented.
  Symptom is zero bytes and no error. This is why `src/translate/opencode.ts`
  uses `spawn` with `stdio: ['ignore', …]` rather than `execFile`.
- **Never pin an opencode model.** The free roster rotates; a model that answered
  yesterday starts returning "the free tier can only be used from within
  OpenCode". Leave it unset so opencode's default is used.
- **translate.wordpress.org rate-limits a tight loop.** No `Retry-After`, no
  headers — the thirtieth of 41 sequential requests returned 429 and succeeded
  twenty seconds later. `src/wporg/fetch.ts` paces and retries; keep it.
- **A 404 from translate.wordpress.org is a 116 KB HTML page.** Check the status
  and content type, never the byte count.
- **`glossary_entries` holds two kinds of row.** Translation memory has
  `pos IS NULL` and one translation per source/context/tag; terminology has
  `pos IS NOT NULL` and keys on the translation too, because the official
  glossary offers alternatives under one part of speech. They have separate
  partial unique indexes. Matching uses memory rows only.
- **A glossary entry is a source *and a translation*.** `msgctxt` is not part of
  the key and matching never reads it; it lives in `glossary_entry_contexts` as
  a note. Two wordings of one string are two rows, and matching ranks them
  (D44). Do not reintroduce a "winning" translation on the entry — storing one
  is what hid the alternatives, and measured, the context it was chosen by
  decided none of the matches it could have (R29).
- **Nothing rewrites `translation` on a synced entry.** It is part of the key,
  so an edit makes the row the owner's (`origin = 'owner'`) — otherwise it
  matches no source's wording, loses its vouches and the sweep deletes it (R14).
- **Counts in a select list are paid per sorted row, not per returned row.**
  The glossary page query sorts before it limits, so three counts in its select
  list ran 49 500 times for a hundred rows — 40 s a page (R30). Choose the
  page's ids in a CTE and decorate only those.
- **A scan in `sync.ts` hangs the whole server, it does not merely slow it.**
  `better-sqlite3` is synchronous, so a statement that loses its index blocks
  the HTTP loop — the panel cannot even poll its own progress. An `OR` across
  two different index lookups is the way to lose it; write two seeks joined by
  `coalesce` instead, and spell `msgctxt IS NULL` as `ifnull(msgctxt, '') = ''`
  because that is what `idx_glossary_memory_key` is built on. Measured 6.777 ms
  against 0.007 ms per lookup (R28). `test/sync-plan.test.ts` asserts the plan.
- **SQLite `NOCASE` folds ASCII only.** `içerik` and `İÇERİK` compare unequal, so
  tag names are folded in the application with Turkish rules.
- **The style guide is seeded once**, from `style-guide/tr-genel.md`, on a
  database's first open. Editing the file does not reach existing databases —
  `npm run style-guide:sync` does that, and refuses when the stored text looks
  hand-edited.
- **The quality checks and the AI prompt must agree.** The checks allow a
  translated `title` and any ordering; the prompt has to say so, or the model
  produces English tooltips the checks then bless. A test asserts the prompt
  carries both rules.

## Schema changes

Forward-only migrations in `src/db/migrations.ts`, each with `PRAGMA
user_version` moved to match. `schema.sql` is version 1 and is not edited again —
a database created months ago and one created today must end up identical, not
merely similar.
