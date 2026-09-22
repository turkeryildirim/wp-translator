# ADR-0002 — AI provider

- **Status:** Proposed
- **Date:** TBD
- **Phase:** 2 — see [`../02-architecture.md`](../02-architecture.md), Step 2
- **Relates to:** D16, D7, D8, D9

## Context

Strings with no exact glossary match are translated by an AI provider (D7). Each request carries a context bundle (D8): the wordpress.org project page, the `readme.txt`, where the string appears (admin screen vs. end-user facing), the relevant glossary terms, and the style guide (D12).

The decisive criterion is **not** raw fluency but **instruction adherence**. D9 makes placeholder, HTML and plural mismatches *blocking*, so a model that produces elegant Turkish while mangling `%1$s` or dropping a `<strong>` creates more review work than it removes. Honouring the glossary and the per-domain style rules matters for the same reason — consistency is the entire point of the project.

Secondary criteria: cost per project at realistic string counts (a mid-sized plugin runs to several hundred strings), throughput, and whether the owner is comfortable sending plugin strings to a third-party service.

## Options considered

### A — Claude API (Anthropic)
- *For:* TBD
- *Against:* TBD
- *Note:* if this is selected, load the `claude-api` skill and verify current model IDs, pricing and prompt-caching behaviour against the reference rather than from memory.

### B — OpenAI API
- *For:* TBD
- *Against:* TBD

### C — Local model (Ollama or similar)
- *For:* TBD
- *Against:* TBD

### D — Pluggable provider interface
- *For:* TBD
- *Against:* TBD

## Decision

TBD

## Consequences

TBD
