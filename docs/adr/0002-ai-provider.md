# ADR-0002 — AI provider

- **Status:** Accepted
- **Phase:** 2
- **Relates to:** D16, D7, D8, D9

## Context

Strings with no exact glossary match are translated by an AI provider (D7), each request carrying the context bundle from D8.

The decisive criterion is **instruction adherence**, not fluency. D9 makes placeholder, HTML and plural mismatches blocking, so a model that writes elegant Turkish while dropping a `%1$s` creates review work rather than removing it.

The owner already runs **opencode** (v2.0.11) and wants it to be the gateway, rather than this tool implementing one provider integration at a time.

## Decision

**A `TranslationProvider` interface with exactly one implementation: opencode.**

The interface stays — it takes a batch of source strings plus the assembled context bundle and returns translations keyed back to their units — but the question of *which model* moves out of this codebase entirely and into opencode's own configuration. Adding OpenAI, a local model, or anything else becomes `opencode auth` plus a model string, with no change here.

## What opencode offers, verified

- A background HTTP server: `opencode service start`, URL reported by `opencode service status`, on a random port. HTTP basic auth, the password in `~/.config/opencode/service.json`.
- OpenAPI 3.1 at `/openapi.json`, 113 operations. (`/doc` serves the web UI, not the spec.)
- The call sequence is `session.create` → `session.switchModel` → `session.switchAgent` → `session.prompt` → `session.message.list`.
- `GET /api/provider` and `GET /api/model` enumerate what is configured.
- **Assistant messages carry `cost` in USD and `tokens` broken into input, output, reasoning and cache.** The cost reporting the pipeline needs comes for free, per model, rather than being reimplemented per provider.

## Consequences

- **opencode is an agent, not a completion API.** `session.prompt` takes `{text, agents, skills, files, …}` — there is no per-request `model` or `tools` field. Model is set on the session; tool restriction lives in opencode's own agent configuration, which is read-only over HTTP.

  Translation therefore runs under a **dedicated opencode agent with tools disabled**. Without that, the model can attempt a tool call, the permission API raises a request, and the batch blocks waiting for an answer nobody is there to give. This agent is a setup prerequisite, not something the tool can create for itself.

- **No structured-output schema.** There is no JSON-schema field on the prompt, so the response format is enforced by instruction and by parsing. The id-matching rule already in the pipeline does the real work: any id returned that was not sent, or any sent id missing from the response, fails the batch instead of being guessed at.

- **A local runtime dependency.** The tool needs opencode's service running, and reads its URL and password from `~/.config/opencode/service.json`. Startup checks the service is up and that at least one model is configured, and says so plainly rather than failing mid-batch.

- **Provider comparison still works**, one level down: switching model per batch is a session call, and opencode reports cost and tokens for each, so placeholder-damage rate and cost per project remain measurable across models.

- **Setup prerequisite, currently unmet.** As installed, opencode has no authenticated providers and no models — `opencode auth list` reports none and `opencode models` is empty. Nothing can translate until the owner authenticates at least one provider.

## Open

Whether to drive opencode over its HTTP API or through `opencode run --format json`. Both work; the trade-off is session reuse and no process-per-batch against a smaller surface to break when opencode changes.
