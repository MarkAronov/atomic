# Changelog

This package is a Bastani fork of `@earendil-works/pi-ai`. Upstream history lives in [earendil-works/pi](https://github.com/earendil-works/pi/blob/v0.84.2/packages/ai/CHANGELOG.md).

## [Unreleased]

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
