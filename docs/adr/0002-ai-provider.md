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
- Assistant messages carry `cost` in USD and `tokens` broken into input, output, reasoning and cache. Not used here — opencode runs on a subscription, so the tool tracks progress in strings, not money (D40).

## Consequences

- **opencode is an agent, not a completion API.** `session.prompt` takes `{text, agents, skills, files, …}` — there is no per-request `model` or `tools` field. Model is set on the session; tool restriction lives in opencode's own agent configuration, which is read-only over HTTP.

  Translation therefore runs under a **dedicated opencode agent with tools disabled**. Without that, the model can attempt a tool call, the permission API raises a request, and the batch blocks waiting for an answer nobody is there to give. This agent is a setup prerequisite, not something the tool can create for itself.

- **No structured-output schema.** There is no JSON-schema field on the prompt, so the response format is enforced by instruction and by parsing. The id-matching rule already in the pipeline does the real work: any id returned that was not sent, or any sent id missing from the response, fails the batch instead of being guessed at.

- **A local runtime dependency.** The tool needs opencode's service running, and reads its URL and password from `~/.config/opencode/service.json`. Startup checks the service is up and that at least one model is configured, and says so plainly rather than failing mid-batch.

- **Provider comparison still works**, one level down: switching model per batch is a session call, and opencode reports cost and tokens for each, so placeholder-damage rate and cost per project remain measurable across models.

- **Setup prerequisite, currently unmet.** As installed, opencode has no authenticated providers and no models — `opencode auth list` reports none and `opencode models` is empty. Nothing can translate until the owner authenticates at least one provider.

## How it is driven

**`opencode run --format json`**, one invocation per batch, rather than the HTTP API. The CLI surface is far smaller than 113 operations and the flags are more stable than the API shape — the published docs already describe a different API than the installed version exposes.

Measured (R17):

- **Startup costs 0.09–0.13 s** with the background service running, 0.45 s cold. The CLI talks to that same service, so it is not paying for a runtime each time. At roughly 290 batches for WooCommerce this is about 30 seconds in total, against model latency measured in minutes — not a reason to prefer the API.
- **`--format json` emits newline-delimited streaming events**, not a single JSON document: `{"type":"step_start",…}`, `{"type":"text",…}`, each carrying `sessionID`, `messageID` and a `part`. The implementation reads the stream and assembles the text parts.
- **With no model configured, `opencode run` hangs** rather than failing. It emits `step_start`, then stalls. This makes the preflight check mandatory rather than merely tidy: before a batch runs, the tool confirms the service is up and `opencode models` is non-empty, and refuses with a clear message otherwise.
- A fresh session per batch is the default and is what we want — no context bleeding from the previous batch into the next.

The batch is handed over as a **JSON file** via `--file` rather than inlined in the prompt (D39), and the reply's JSON is extracted from the assembled text.

**Verified in Phase 4** against `opencode/mimo-v2.6-flash-free` (OpenCode Zen, free tier): a 20-string batch returned in 14.6 s as a bare JSON array with all 20 ids intact and all quality checks passing, with **no tool calls** — `--file` is treated as content to translate. Injecting a glossary block into the prompt changed all four covered terms to the glossary's wording and left the rest alone (R22, R23).

**`--format json` requires stdin to be closed** or the command hangs indefinitely (R21). This is undocumented.
