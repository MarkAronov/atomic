# Changelog

This package is a Bastani fork of `@earendil-works/pi-ai`. Upstream history lives in [earendil-works/pi](https://github.com/earendil-works/pi/blob/v0.84.2/packages/ai/CHANGELOG.md).

## [Unreleased]

### Breaking Changes

- Renamed the exported `GoogleThinkingLevel` type to `GoogleApiThinkingLevel` and added `ResolvedGoogleThinkingLevel` for normalized adapter levels.

### Changed

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
