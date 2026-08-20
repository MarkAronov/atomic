# Changelog

This package is a Bastani fork of `@earendil-works/pi-ai`. Upstream history lives in [earendil-works/pi](https://github.com/earendil-works/pi/blob/v0.84.2/packages/ai/CHANGELOG.md).

## [Unreleased]

### Changed

- Vendored into the Atomic monorepo as `packages/ai` and rebranded the published package to `@bastani/pi-ai`. The first npm version must be published by hand so trusted publishing can be attached; later tagged Atomic releases publish it from `publish.yml`.

- Added raw `COPILOT_GITHUB_TOKEN` Copilot chat integration headers and moved env-token host routing into the exported `@bastani/pi-ai/providers/github-copilot-env` module ([#2522](https://github.com/bastani-inc/atomic/issues/2522)).
