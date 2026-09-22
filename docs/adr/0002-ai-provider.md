# ADR-0002 — AI provider

- **Status:** Accepted, provider roster pending
- **Phase:** 2
- **Relates to:** D16, D7, D8, D9

## Context

Strings with no exact glossary match are translated by an AI provider (D7). Each request carries the context bundle from D8: project metadata, readme, where the string appears, the relevant glossary terms, and the style guide.

The decisive criterion is **instruction adherence**, not fluency. D9 makes placeholder, HTML and plural mismatches blocking, so a model that writes elegant Turkish while dropping a `%1$s` or a `</strong>` creates review work rather than removing it. Honouring the glossary and the per-tag style rules matters for the same reason: consistency is the point of the project.

Secondary criteria: cost per project at realistic string counts — a mid-sized plugin runs to several hundred strings, WooCommerce to fourteen thousand — throughput, and whether plugin strings may leave the machine.

No single provider is obviously right on all of these, and the ranking is likely to change as models change.

## Decision

**A pluggable `TranslationProvider` interface.** No provider is hard-wired; the concrete roster is supplied by the owner and configured in the panel.

The interface is the commitment. It takes a batch of source strings plus the assembled context bundle and returns translations keyed back to the units they came from, so that swapping the implementation behind it changes nothing else.

## Consequences

- **Which providers ship is still open** — the owner will supply the list. Nothing else in the design waits on it.
- Provider-specific concerns stay behind the interface: authentication, batching limits, token budgets, structured-output format, retry and rate-limit handling.
- Every provider's output goes through the same validation before storage, and lands in `review` regardless of source (D22). No provider is trusted more than another.
- Because providers are comparable, cost and placeholder-damage rate can be measured on real projects rather than argued about. The pipeline records which provider produced each translation.
- Credentials are per-provider and stored locally; see the storage section of `02-architecture.md`.
- A local model (Ollama or similar) is an implementation of the same interface, so "keep the strings on this machine" becomes a configuration choice rather than a rewrite.
