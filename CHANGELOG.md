# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0-rc.2] - 2026-09-02

### Added

- Pluggable local web-search backends (DuckDuckGo Instant Answer default, plus
  Tavily, Brave, and SearXNG) and Anthropic hosted web search on Auto.
- Vision: image attachments are sent to models that accept them.
- Per-conversation generation controls and custom instructions.
- Dedicated web-search settings section (Auto / Hosted / Local).
- Conversation export as Markdown and JSON.
- Mermaid diagrams and KaTeX math in chat markdown.
- Opt-in workspace folder tools and a workspace chip in chat.
- Message edit-and-resend, including mid-thread fork.
- Runtime and build-time white-label branding.
- Orange-Dark palette.

### Fixed

- Tool-using streams stay a single assistant turn instead of splitting into
  duplicate bubbles.
- Release packaging: Cargo version follows the tag; the smoke build runs
  without a signing key.

## [0.1.0-rc.1] - 2026-08-22

First packaged release candidate. Unsigned installers for Windows, macOS
(Apple silicon and Intel), and Linux, with updater-signed payloads.

### Added

- Initial public release: AGPL-3.0 licensing, contributor documentation, and
  third-party attribution.

[Unreleased]: https://github.com/runningpixels/conduit/compare/v0.1.0-rc.2...HEAD
[0.1.0-rc.2]: https://github.com/runningpixels/conduit/compare/v0.1.0-rc.1...v0.1.0-rc.2
[0.1.0-rc.1]: https://github.com/runningpixels/conduit/releases/tag/v0.1.0-rc.1
