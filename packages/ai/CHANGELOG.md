# Changelog

This package is a Bastani fork of `@earendil-works/pi-ai`. Upstream history at the audited Pi `main` sync point (`b8b873b9872db04a938fb4357b5e8e824ddc051c`) lives in [earendil-works/pi](https://github.com/earendil-works/pi/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/ai/CHANGELOG.md).

## [Unreleased]

### Added

- Added first-class Claude Fable 5.1 (`claude-fable-5-1`) support to the generated catalogs, for every provider whose live catalog publishes the model. Each entry carries the model's 1,000,000-token context window, 128,000-token maximum output, and that provider's own pricing, including the reduced $0.25 per million cache read (a quarter of Claude Fable 5's rate) and the US-only inference premium on the Amazon Bedrock `us.` profile. Adaptive thinking is always on, `off` is denied, and `low`, `medium`, `high`, `xhigh`, and `max` are all selectable, with Anthropic's `high` default preserved. Provider catalogs move independently of releases, so the exact mirror set tracks them rather than being fixed here; a provider "latest" alias may also route to Fable 5.1 without naming it.
- Added the published server-side fallback targets for Claude Fable 5.1. Requests now send `fallbacks` naming Claude Opus 4.8 and Claude Opus 5, so a classifier refusal can be retried server-side and can redeem the prompt-cache fallback credit.
- Added `compat.enforcesPreservedThinkingBinding`, `compat.delegatesThinkingModelBinding`, and `compat.supportsForcedToolChoice` to the Anthropic Messages compatibility options, so a custom Anthropic-compatible provider can declare that its API adjudicates thinking-block signatures, that its model runs Anthropic's conversation check, and whether its model accepts forced tool use.
- Added visibility for thinking blocks the Anthropic API drops. When a response reports `input_transformations`, the assistant message now carries an `anthropic_input_transformations` diagnostic with the dropped-block count, the reasons (`prefix_binding_mismatch` or `model_binding_mismatch`), and the block paths, instead of the drop being silent. Both report sites are read: `message_start`, and the final `message_delta` after a mid-stream server-side fallback.
- Added `compat.supportsTemperature` to the Amazon Bedrock and OpenAI-completions compatibility options, mirroring the field the Anthropic Messages compat already had, so a model that rejects the `temperature` request field can be marked as such on those APIs too.
- Documented that generated `input` metadata lists only the modalities Atomic can send. `["text", "image"]` on Claude entries matches Anthropic's own published capability row for those models (Claude Fable 5.1: `Input → output: Text and images → text`). Anthropic documents PDF separately as a platform feature — "All active models support PDF processing" — routed through the same vision path as images, which is why all 14 Anthropic models in the models.dev catalog carry an identical `pdf` flag. Atomic has no document content block, so PDF input remains unsupported across the catalog.

### Fixed

- `NO_PROXY` now matches a root domain and its subdomains consistently, and understands bracketed IPv6 hosts, bare IPv6 hosts, port-scoped entries, and a bare `*` entry anywhere in the list. Previously an entry such as `example.com` did not exempt `api.example.com`, and `[2001:db8::1]` was parsed as a host/port pair ([#8737](https://github.com/earendil-works/pi/pull/8737)).
- Added a `supportsMaxOutputTokens` compatibility flag to `OpenAIResponsesCompat` (default `true`). Setting it to `false` omits `max_output_tokens` from openai-responses requests, for Codex-protocol gateways that reject the parameter with a 400 ([#8941](https://github.com/earendil-works/pi/pull/8941)).
- Fixed Claude Fable 5 and Claude Fable 5.1 sending `temperature` on the Anthropic Messages API. Anthropic rejects non-default `temperature`, `top_p`, and `top_k` on both models with a 400 on every request, whether or not thinking is on, so both are now generated with `supportsTemperature: false` and the field is omitted.
- Fixed Claude Fable 5.1 still sending `temperature` on Amazon Bedrock and OpenRouter. The Bedrock Converse and OpenAI-completions request builders emitted the field unconditionally, so the three Bedrock inference profiles and the OpenRouter entry sent a parameter the model rejects; OpenRouter's own `supported_parameters` for `anthropic/claude-fable-5.1` also omits `temperature`. Those four entries are now generated with `supportsTemperature: false` and both request builders honour it. The guard is scoped to Claude Fable 5.1: every other model on those APIs keeps sending `temperature` exactly as before, including models whose Anthropic documentation also restricts it, which remains a pre-existing gap on those two paths.
- Fixed Claude Fable 5.1 sessions failing with a 400 `invalid_request_error` when a thinking block was replayed behind a changed conversation prefix. Anthropic enforces that check by default for organizations created on or after 2026-08-31, so a dynamic system prompt, a tool-set change, or a model switch could break an otherwise healthy session. Requests for that model now send the `thinking-binding-controls-2026-08-01` beta header with `thinking.block_binding.prefix_mismatch_behavior: "drop_block"`, so the API drops the affected thinking blocks and answers the turn. The field accompanies the header on every request for that model, including turns with no reasoning level, where the header alone would have left the behavior at its rejecting `"error"` default.
- Fixed mid-conversation model switches discarding reasoning that the target model was allowed to read. First-party Anthropic models now replay another Claude model's signed `thinking` and `redacted_thinking` blocks unchanged and let the API decide which ones the target model may use, instead of rewriting them into visible assistant text. Switching up to Claude Fable 5.1 keeps the conversation's reasoning; switching down to an earlier Claude model has the API drop it server-side. Assistant text, tool calls, and tool results are preserved in both directions. The change is scoped to `provider: "anthropic"` on the `anthropic-messages` API; Amazon Bedrock, Google Vertex, and Anthropic-compatible proxies are unchanged.
- Fixed forced tool use being sent to Claude Fable 5.1, which rejects `tool_choice: {"type": "any"}` and `{"type": "tool", ...}` on every request with a 400. The Anthropic `stream()` entry point accepts those shapes, so a caller could construct a request the model was guaranteed to refuse. For a model whose metadata sets `supportsForcedToolChoice: false`, a forced choice is now downgraded to `{"type": "auto"}`, which is Anthropic's documented guidance for those models. `auto` and `none` are never altered, and every other model passes forced choices through unchanged.


## [0.9.16] - 2026-08-29

Cumulative release of the `0.9.16-alpha.5` – `0.9.16-alpha.11` prereleases. The summary below covers the user-visible outcome of that work; the per-change detail remains in the prerelease sections below.

### Added

- Added the Meta Muse Image and Recraft V4 Styles, V4 Styles Pro, V4 Styles Pro Vector, and V4 Styles Vector image models to the generated OpenRouter catalog.
- Added the DeepSeek V4 Flash Vision experimental model to generated catalogs.

### Fixed

- Fixed fragmented Mistral tool calls splitting when continuation chunks omit the tool-call ID ([#8387](https://github.com/earendil-works/pi/issues/8387)).
- Fixed Cloudflare AI Gateway typing and mirrored supported Workers AI models through its compatibility endpoint.
- Fixed OpenAI-compatible Chat Completions reasoning streams to concatenate incremental reasoning deltas instead of replacing earlier content ([#8605](https://github.com/earendil-works/pi/pull/8605)).
- Fixed OpenRouter reasoning controls by deriving `off` support and available effort levels from model metadata, preventing reasoning-mandatory models from receiving `effort: "none"` ([#8454](https://github.com/earendil-works/pi/issues/8454)).
- Fixed OpenAI-compatible Chat Completions requests sending `tool_choice` without tools, which gateways can reject during compaction ([#8607](https://github.com/earendil-works/pi/issues/8607)).
- Fixed OpenAI-compatible Chat Completions ignoring an explicitly requested `toolChoice` when no tools are defined ([#8649](https://github.com/earendil-works/pi/issues/8649), [#8638](https://github.com/earendil-works/pi/issues/8638)).
- Fixed OpenAI-compatible streaming rewriting `thinkingSignature` on every `reasoning_details` delta. Replay metadata is buffered during streaming and serialized once when the thinking block is finalized, including on the error path ([#8671](https://github.com/earendil-works/pi/issues/8671)).

## [0.9.16-alpha.11] - 2026-08-28

### Added

- Added the Meta Muse Image and Recraft V4 Styles, V4 Styles Pro, V4 Styles Pro Vector, and V4 Styles Vector image models to the generated OpenRouter catalog.

## [0.9.16-alpha.10] - 2026-08-28

### Fixed

- Fixed fragmented Mistral tool calls splitting when continuation chunks omit the tool-call ID ([#8387](https://github.com/earendil-works/pi/issues/8387)).

## [0.9.16-alpha.5] - 2026-08-26

### Added

- Added the DeepSeek V4 Flash Vision experimental model to generated catalogs.

### Fixed

- Fixed Cloudflare AI Gateway typing and mirrored supported Workers AI models through its compatibility endpoint.
- Fixed OpenAI-compatible Chat Completions reasoning streams to concatenate incremental reasoning deltas instead of replacing earlier content ([#8605](https://github.com/earendil-works/pi/pull/8605)).
- Fixed OpenRouter reasoning controls by deriving `off` support and available effort levels from model metadata, preventing reasoning-mandatory models from receiving `effort: "none"` ([#8454](https://github.com/earendil-works/pi/issues/8454)).
- Fixed OpenAI-compatible Chat Completions requests sending `tool_choice` without tools, which gateways can reject during compaction ([#8607](https://github.com/earendil-works/pi/issues/8607)).
- Fixed OpenAI-compatible Chat Completions ignoring an explicitly requested `toolChoice` when no tools are defined ([#8649](https://github.com/earendil-works/pi/issues/8649), [#8638](https://github.com/earendil-works/pi/issues/8638)).
- Fixed OpenAI-compatible streaming rewriting `thinkingSignature` on every `reasoning_details` delta. Replay metadata is buffered during streaming and serialized once when the thinking block is finalized, including on the error path ([#8671](https://github.com/earendil-works/pi/issues/8671)).

## [0.9.15] - 2026-08-21

Cumulative release of the `0.9.15-alpha.1` prerelease. The summary below covers the user-visible outcome of that work; the per-change detail remains in the prerelease section below.

### Breaking Changes

- Built-in xAI models now use the OpenAI Responses API only; Completions is no longer registered on the xAI provider.
- Renamed the exported `GoogleThinkingLevel` type to `GoogleApiThinkingLevel` and added `ResolvedGoogleThinkingLevel` for normalized adapter levels.

### Added

- Added provider-neutral `toolChoice` on simple stream requests.
- Generalized OpenAI Completions thinking-token budget fields through `thinkingTokenBudgetField`, with `supportsThinkingTokenBudget` retained as the vLLM alias.
- Added pi's runtime `User-Agent` to Anthropic, Azure Responses, Google, Vertex, Mistral, OpenAI Completions, and OpenAI Responses requests.

### Changed

- `@bastani/pi-ai` now generates its models.dev catalog during package builds and uses the generated catalog for offline compilation.
- Vendored and rebranded the package as `@bastani/pi-ai` in the Atomic monorepo, with later tagged Atomic releases publishing it through trusted publishing.
- Moved `COPILOT_GITHUB_TOKEN` env-token host routing into the exported `@bastani/pi-ai/providers/github-copilot-env` module ([#2522](https://github.com/bastani-inc/atomic/issues/2522)).

### Fixed

- Fixed raw `COPILOT_GITHUB_TOKEN` chat authentication by sending `Copilot-Integration-Id: copilot-developer-cli`, while preserving exchanged OAuth-token behavior ([#2522](https://github.com/bastani-inc/atomic/issues/2522)).
- Fixed Amazon Bedrock Converse Stream and `pi-messages` dropping static custom-model headers; caller headers still override model headers and `null` still suppresses a static header.
- Fixed stalled OpenAI Completions, OpenAI Responses, Anthropic Messages, `pi-messages`, Mistral, and Codex provider streams by applying idle deadlines that abort the request and surface retryable transport errors. Native Codex WebSocket streams now use `streamDeadlineMs` rather than the HTTP timeout ([#2553](https://github.com/bastani-inc/atomic/issues/2553)).
- Ported upstream fixes for Copilot throttling, Kimi cache reads, DeepSeek thinking levels, Google thinking maps, Bedrock headers and reasoning, model catalogs, Anthropic fallback pricing, Azure tool choice, Z.AI effort metadata, and OpenAI reasoning replay. Cerebras now defaults to `gpt-oss-120b`, and the unused OpenTelemetry dependency was removed.

## [0.9.15-alpha.1] - 2026-08-21

### Breaking Changes

- Built-in xAI models now use the OpenAI Responses API only. Completions is no longer registered on the xAI provider.

- Renamed the exported `GoogleThinkingLevel` type to `GoogleApiThinkingLevel` and added `ResolvedGoogleThinkingLevel` for normalized adapter levels.

### Added

- Added provider-neutral `toolChoice` on simple stream requests.
- Generalized OpenAI Completions thinking-token budget fields (`thinkingTokenBudgetField`, with `supportsThinkingTokenBudget` as the vLLM alias).
- Send pi's runtime `User-Agent` on Anthropic, Azure Responses, Google, Vertex, Mistral, OpenAI Completions, and OpenAI Responses requests.

### Changed

- `@bastani/pi-ai` `build` now runs `generate-models` then `build:offline`, matching upstream. Catalog JSON under `src/providers/data/` is generated from models.dev at build time and is no longer committed.

- Vendored into the Atomic monorepo as `packages/ai` and rebranded the published package to `@bastani/pi-ai`. The first npm version must be published by hand so trusted publishing can be attached; later tagged Atomic releases publish it from `publish.yml`.

- Moved `COPILOT_GITHUB_TOKEN` env-token host routing into the exported `@bastani/pi-ai/providers/github-copilot-env` module ([#2522](https://github.com/bastani-inc/atomic/issues/2522)).

### Fixed

- Fixed raw `COPILOT_GITHUB_TOKEN` Copilot chat authentication by sending `Copilot-Integration-Id: copilot-developer-cli`; exchanged OAuth tokens containing a `tid=` segment retain their existing behavior ([#2522](https://github.com/bastani-inc/atomic/issues/2522)).
- Fixed the Amazon Bedrock Converse Stream and `pi-messages` APIs dropping a custom model's static `headers`: both now merge `model.headers` beneath caller `options.headers`, matching every other API implementation, with `null` caller values still suppressing a static header.
- Fixed GitHub Copilot requests on the default `transport: "auto"` hanging forever after a response-body decompression failure such as `Library error: zlib error: incorrect header check`. The stalled body never rejected the adapter's async iterator, so the attempt never settled and retry/model fallback never advanced. Provider streams for the `openai-completions`, `openai-responses`, and `anthropic-messages` APIs are now wrapped in an idle stream deadline that closes the source iterator and settles the attempt as a retryable transport error, and the transient-error classifier recognises zlib, `incorrect header check`, decompression, and `Library error:` wrapper text ([#2553](https://github.com/bastani-inc/atomic/issues/2553)).
- Fixed the idle stream deadline leaving the stalled provider request open: expiry now aborts an attempt-local signal, combined with the caller's signal, so the underlying HTTP request and socket are torn down before retry or model fallback starts instead of accumulating abandoned connections. The caller's own signal semantics are unchanged, the deadline error still surfaces as the retryable transport failure, and deadlines above the platform's 32-bit timer limit no longer clamp to an immediate timeout ([#2553](https://github.com/bastani-inc/atomic/issues/2553)).
- Fixed idle stream deadlines for the native `pi-messages`, Mistral conversations, and Codex SSE transports: each now threads the deadline-owned abort signal through the request and bounds the decoded event loop, so a stalled response settles and closes its body instead of remaining pending ([#2553](https://github.com/bastani-inc/atomic/issues/2553)).
- Fixed the native Codex `transport: "auto"` WebSocket path using the HTTP `timeoutMs` as its idle limit: connected streams now use the effective `streamDeadlineMs`, so a configured stream deadline triggers idle recovery without waiting for the unrelated HTTP timeout ([#2553](https://github.com/bastani-inc/atomic/issues/2553)).
- Ported unreleased `@earendil-works/pi-ai` `fix(ai)` commits from `earendil-works/pi` main after v0.84.2:
	- GitHub Copilot login now updates only known tool-capable models with unconfigured policies, runs those updates sequentially, and retries throttled `/models` and policy requests within a bounded delay ([#7850](https://github.com/earendil-works/pi/issues/7850), [#8254](https://github.com/earendil-works/pi/pull/8254)).
	- Kimi OpenAI-compatible usage now treats top-level `cached_tokens` as cache reads ([#8119](https://github.com/earendil-works/pi/pull/8119), [#8075](https://github.com/earendil-works/pi/issues/8075)).
	- DeepSeek V4 Flash on OpenCode and OpenCode Go exposes a `low` thinking level ([#8181](https://github.com/earendil-works/pi/pull/8181)).
	- Google Generative AI and Vertex AI honor `thinkingLevelMap` on custom models ([#8135](https://github.com/earendil-works/pi/issues/8135)).
	- Amazon Bedrock `onResponse` forwards raw Smithy response headers ([#8243](https://github.com/earendil-works/pi/pull/8243), [#8234](https://github.com/earendil-works/pi/issues/8234)).
	- Xiaomi catalog generation drops shut-down MiMo V2 model names ([#8187](https://github.com/earendil-works/pi/issues/8187)).
	- China ZAI Coding Plan uses the `zhipuai-coding-plan` catalog, including GLM-4.6V, and PAYG-equivalent usage estimates ([#8220](https://github.com/earendil-works/pi/issues/8220)).
	- Qwen Token Plan Individual includes `deepseek-v4-pro-0813` ([#8194](https://github.com/earendil-works/pi/issues/8194)).
	- Anthropic server-side refusal fallbacks are declared in model metadata and priced from the returned fallback model, not stream options ([#8258](https://github.com/earendil-works/pi/pull/8258), [#8319](https://github.com/earendil-works/pi/pull/8319), [#8352](https://github.com/earendil-works/pi/pull/8352), [#8285](https://github.com/earendil-works/pi/issues/8285)).
	- Azure OpenAI Responses forwards `toolChoice`.
	- Baseten GLM-5.2 declares image input.
	- Bedrock round-trips non-Anthropic redacted reasoning ([#8314](https://github.com/earendil-works/pi/pull/8314)).
	- Z.AI reasoning effort metadata is derived from models.dev options, preserving GLM-5.2 `none` and exposing GLM-5.3 low/high/max ([#8336](https://github.com/earendil-works/pi/issues/8336)).
	- OpenAI-compatible Chat Completions preserves and resends assistant-level `reasoning_details` via `thinkingSignature` ([#8246](https://github.com/earendil-works/pi/pull/8246), [#7994](https://github.com/earendil-works/pi/issues/7994)).
- Removed the unused `@opentelemetry/api` dependency from `@bastani/pi-ai`.
- Cerebras default model is now `gpt-oss-120b`.
