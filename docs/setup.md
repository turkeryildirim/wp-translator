# Setup

## opencode

The tool drives opencode, which must be configured once.

### 1. A provider

`opencode auth` — any provider opencode supports. `opencode api model.list` then
shows what is available.

### 2. A tool-free translation agent

opencode is a *coding* agent: its default `build` agent can read files, write
them and run shell commands. Asked to translate, a model may instead try to
*read* the attached file with a tool. A tool call raises a permission request,
nothing answers it because no human is watching, and the run hangs.

`~/.config/opencode/opencode.json`:

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

Verify:

```
opencode run --agent wp-translator "List the files here using your tools."
→ I can't list files because I don't have tool access.
```

`opencode api agent.list` returns an empty array even when the agent loads;
the run header (`> wp-translator · <model>`) is what confirms it.

### 3. Do not pin a model

The free roster rotates. A model that answered yesterday can start returning
*"OpenCode's free tier can only be used from within OpenCode"*, and another
appears in its place. Leave the model unset so opencode's own default is used,
or pick one in Settings knowing it may need changing.

## What a fresh database already has

Nothing to paste in. On first open it carries:

- **41 trusted sources** — WordPress core and its sub-projects, the large
  plugins with their readmes, a theme, both mobile apps with release notes, and
  the meta sites. All under one `wordpress` tag, ranked core first.
- **The Turkish style guide** — TDK's spelling rules reduced to decisions a
  translator applies, plus the WordPress title-case rule. Editable in the panel;
  seeding happens once, so later edits are never overwritten.

The **official WordPress Turkish glossary** is not seeded, because it needs a
network fetch. Pressing **Güncelle** on the trusted-sources screen downloads it
along with every source: 41 exports plus 511 terms, about 54 000 glossary
entries, a little over a minute.

**Splitting the tag is the owner's call.** Everything starts under `wordpress`.
Giving WooCommerce its own tag is what makes `item` come out as `ürün` there and
`öge` elsewhere; until that split exists the two senses share a tag and rank
decides.

## Running

```
npm install
npm run build:panel
npm run serve          # http://127.0.0.1:4173
```

`WPT_DB` sets the database path, `WPT_PORT` the port.
