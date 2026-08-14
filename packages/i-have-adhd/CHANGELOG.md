# Changelog

All notable changes to the `@bastani/i-have-adhd` extension will be documented in this file.

## [Unreleased]

## [0.9.13] - 2026-08-13

Cumulative release of the `0.9.13-alpha.2` prerelease. The summary below covers the user-visible outcome of that work; the per-change detail remains in the prerelease section below.

### Added

- Added the upstream `i-have-adhd` skill and Atomic extension as a bundled first-party package, with `/i-have-adhd [on|off]`, the `--no-adhd` startup flag, the `.i-have-adhd-off` agent-directory flag file, and the `stop adhd mode` / `normal mode` stop phrases.

### Changed

- ADHD-friendly output is on by default for new sessions, and saved per-session state survives restarts, branches, and compaction.
- The footer status reads `ADHD Mode` and appears only while the mode is on.

## [0.9.13-alpha.2] - 2026-08-12

### Added

- Added the upstream `i-have-adhd` skill and Atomic extension as a bundled first-party package.
- Added `/i-have-adhd [on|off]`, the `--no-adhd` startup flag, the `.i-have-adhd-off` agent-directory flag file, and the `stop adhd mode` / `normal mode` stop phrases.

### Changed

- Enabled ADHD-friendly output by default for new sessions while preserving saved per-session state across restarts, branches, and compaction.
- Renamed the footer status label from `ADHD ON` to `ADHD Mode`; the status is only shown while the mode is on, so the `ON` suffix was redundant.
