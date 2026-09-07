# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- German interface. Pick a language in Settings → Appearance, or leave it on
  System to follow the OS. The choice also sets the language the assistant
  replies in, unless you write to it in another language.
- Dates, times, number grouping, file sizes and sorting now follow the language
  you picked rather than the machine's region. A German reader gets German
  month names and `2,5 MB`, not `2.5 MB`.

### Changed

- File sizes read `4.2 kB` rather than `4.2 KB`, and context windows read
  `200K` rather than `200k` — both are the standard forms for the reader's
  locale rather than hardcoded English.

### Fixed

- Truncated text — folder names, tool-call summaries, the workspace-folder chip
  — now shows its full value on hover instead of ending in an ellipsis with no
  way to read the rest.
- The connector consent dialog described a tool's permission level with a
  sentence assembled in the backend, so it could not be translated. It is built
  from the permission level and the tool's own description now.

## [0.1.0-rc.3] - 2026-09-06

### Added

- Conversation pin, archive, and one-level folders in the history rail.
- Agent run-control (t1-2): follow-up message queue while a turn runs, interrupt/steer
  mid-loop, per-tool approval memory (this chat / always), and native `ask_user` forms.
- Per-chat `SKILL.md` skill packages.
- User-approved encrypted memory, with a queued `remember` tool and an
  inspectable list of what has been stored.
- Remote MCP over streamable HTTP, including CIMD OAuth and one-click install
  from the official registry.
- Context gauge that measures next-request prompt fill rather than summed turn
  usage, with automatic compaction that journals older turns into a summary as
  the chat nears the model window.
- A segment timeline so thinking, tool calls, and final answers render in the
  order they happened.

### Fixed

- Thoughts and tool calls stay above the streamed answer. Empty content stubs
  were opening a text timeline slot before reasoning arrived, which pushed the
  Thought chip and tools below the answer on GLM-style streams.
- The updater manifest is uploaded without PATCHing the release.

### Changed

- Always-show-reasoning is now on by default.
- Dependency updates: the react, tauri, vite/vitest, js-minor-patch, and
  rust-minor-patch groups, `infer` 0.19.0 to 0.22.0, and the GitHub Actions
  group.

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

[Unreleased]: https://github.com/runningpixels/conduit/compare/v0.1.0-rc.3...HEAD
[0.1.0-rc.3]: https://github.com/runningpixels/conduit/compare/v0.1.0-rc.2...v0.1.0-rc.3
[0.1.0-rc.2]: https://github.com/runningpixels/conduit/compare/v0.1.0-rc.1...v0.1.0-rc.2
[0.1.0-rc.1]: https://github.com/runningpixels/conduit/releases/tag/v0.1.0-rc.1
