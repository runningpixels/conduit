# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Ask for a picture and you get one. On OpenAI, Gemini and OpenRouter, a prompt
  that plainly asks for an image — "draw me a logo for my bakery" — generates
  one and saves it with the chat, where it appears in the thread and in the
  document panel. The image is stored locally, not linked from the provider, so
  it does not vanish when a remote URL expires.
  Because each image is billed, you are asked once before the first one, and
  none is ever generated without that confirmation. Declining still sends your
  message, just without offering the tool. Asking *about* image generation —
  "can you generate images?" — is a question, not a request, and costs nothing.
  Providers without an image endpoint are unchanged: no new button, no dialog,
  nothing to notice.

- The prompts and resources your connected servers offer are now reachable from
  the composer, not just their tools. A prompt picker fills in whatever
  arguments the prompt declares and drops the result into the composer, where
  you can read and edit it before sending. A resource picker attaches a
  document to the next message; what it contains is redacted, size-capped and
  checked before it reaches the model, and a resource that tries to issue
  instructions of its own is refused and named rather than quietly included.
  An attachment lasts one message, so nothing keeps riding along after you have
  moved on. Servers that offer only tools look exactly as they did.

## [0.1.0-rc.5] - 2026-09-15

### Added

- Six more providers: xAI, Z.ai, Moonshot AI, Qwen, Together AI and Fireworks
  AI. Each takes an API key like the others, and each has a base URL field for
  regional or self-hosted endpoints — Qwen and Moonshot default to their
  international endpoints.
- Anthropic and OpenAI have a base URL field too, so either can point at a
  compatible endpoint such as Z.ai's Anthropic-compatible API or a LiteLLM
  proxy. Hosted web search is only offered on the official endpoints.
- Themes go beyond colour. A theme now sets the type, corner radii, borders,
  elevation and motion as well as the palette, and one Theme picker in
  Settings → Appearance (and in first-run setup) chooses it. Six new themes
  join the three existing palettes: Amber Terminal, Green Phosphor, Amber
  Paper, Graphite, Editorial and High Contrast (AAA contrast).
- Your own themes: a `.theme.md` file in the app's `themes` folder extends a
  built-in theme with your colours. Theme files take hex colours and a fixed
  set of structural choices only — no CSS, no URLs. Settings → Appearance can
  create an example file to start from.
- A Reading font setting picks the face for assistant replies — sans, serif or
  whatever the theme uses.
- Optional automatic updates. Settings → About gains an Automatic updates
  choice: only when you check (the default, unchanged), tell me when an update
  is available — checked shortly after launch and then daily — or install when
  you quit, which also downloads and verifies the update in the background —
  never while a reply is streaming. Turning update checks off still means no
  network request at all.
  Automatic is not offered for the Linux `.deb`, which would need a password
  prompt after the window has closed.
- The sidebar can be resized by dragging its edge, from the keyboard, or reset
  with a double-click; dragging it small enough closes it.
- A settings button in the title strip opens Settings on the section you were
  last on, and its menu jumps straight to Providers, Chat defaults, Connectors,
  Appearance, Privacy, diagnostics export and About.
- Search in Settings: type a setting's name and the section list narrows to
  where it lives, and opening a result scrolls to and highlights it.
- A keyboard shortcuts sheet (`Ctrl+/`, `⌘/` on macOS) lists every shortcut.
  Three of them — Fork, Copy last message and Switch provider — were not
  written down anywhere before.
- Every conversation in the sidebar has a ⋯ menu, reachable from the keyboard
  with Shift+F10 or the context-menu key, and conversations can be renamed
  from it or by double-clicking. Renaming used to work only on the open chat.
- The artifact panel can be expanded (`Ctrl+Shift+E`) to take everything but a
  narrow chat column, and restored to the exact layout you had. Its width is no
  longer capped at 560px, so HTML artifacts stop rendering at phone width.
- While the assistant writes a document you can see it happening: the chat, the
  tool card and the document panel show the title, the line count and the size
  as they grow, and a "still working" note appears if the provider goes quiet.
  An optional Live preview renders the document as it is written.
- Documents too long for one reply can now be written at all. The assistant
  saves the structure first and fills it in section by section, the chat counts
  down the sections left, and the preview marks the ones not written yet. If the
  turn runs out of time part-way, the document is kept as far as it got and a
  Continue building button picks it up where it stopped.
- Revising a document changes only the part that differs instead of rewriting
  the whole thing, so edits are faster and cost less.

### Changed

- Settings sections are grouped under Models, Assistant and App.
- A chat with no artifacts opens without the empty artifact panel; the panel
  opens once there is something to show. A panel you closed stays closed.
- Markdown and text artifacts are set at a readable line length in a wide
  panel, with tables allowed to run wider.
- The window title names the open conversation, so the taskbar and Alt-Tab can
  tell windows apart.
- The Settings gear, `Ctrl+,`, the command palette and the sidebar menu all
  open the same section. The sidebar's Settings item used to open Appearance
  while its own `Ctrl+,` hint opened Providers.
- The command palette has an entry for every Settings section.
- A turn ends as soon as the document is saved, instead of spending another
  5–30 seconds having the model confirm what it just wrote. Settings → Chat
  defaults → Finish after writing a document turns this off.
- Replies are no longer cut short by a low default output limit: Anthropic sent
  4,096 tokens' worth whenever no limit was set — a few hundred lines of HTML —
  and Gemini capped every reply at 8,192. Each model's own limit applies now.
- The turn time limit no longer stops a reply that is still arriving, and it
  gives a document more time for as long as it keeps saving progress.

### Fixed

- Picking a cloud provider in first-run setup or Settings before the provider
  list had finished loading — or when it failed to load — left local-only mode
  on, so the first message failed with an error about a setting the user had
  never seen. Local-only is now turned off for any cloud provider, whether or
  not the list has arrived.
- The model menu labelled models from OpenRouter, Groq, DeepSeek, Mistral and
  other cloud providers "self-hosted" whenever it had no price for them.
- On a narrow window the sidebar and artifact panel were hidden and their
  toggles did nothing, so no conversation or artifact could be reached with a
  mouse. They now open as overlays over the chat.
- Closing Settings within a quarter of a second of changing something could
  lose the change, and a late save could overwrite the language chosen during
  first-run setup.
- Dragging the artifact panel's edge trailed the pointer, and its arrow keys
  moved the separator the wrong way.
- A collapsed sidebar animated shut on every launch.
- Menus behave the same everywhere: they take focus, respond to arrow keys,
  close on Escape and stay on-screen. The composer's folder menu could not be
  closed with Escape.
- Buttons inside a hidden sidebar or panel could still be reached with Tab.
- Switching chats briefly showed the previous chat's artifact count on the
  panel button.
- Artifact tab names were cut to nothing at every panel width.
- A document cut off by the output limit used to fail with a message about a
  missing field and vanish. The reply now says which document was cut off and
  which limit it hit, and offers to retry without the limit. A model that
  spends its whole limit thinking is told to think less and tried once more,
  and a provider that gives up on a long silent reply gets it in parts.
- Switching chats while a reply was arriving left every later message queued
  and unsent, in every chat, until the app restarted.
- Keyboard shortcuts stopped working after clicking inside an HTML preview.
- Clearing Max tokens, temperature or the user instructions in Settings put the
  old value straight back.
- Searching a large project folder could run for minutes and use up the turn.
- Ollama never received tool definitions, so it could not use tools at all.
- The chat column could be scrolled sideways, tool cards printed whole files,
  and notifications covered the document panel's toolbar.

## [0.1.0-rc.4] - 2026-09-12

### Added

- First-run setup now opens by asking for your language, theme, palette and
  text size, so the rest of it is readable before it explains anything. It also
  gains a step for the settings the welcome text makes promises about —
  local-only mode, where API keys are stored, update checks and diagnostics —
  and ends on a review of what was actually configured.
- The interface is available in German, Spanish, French, Japanese, Brazilian
  Portuguese, Korean and Simplified Chinese. Pick a language in Settings →
  Appearance, or leave it on System to follow the OS. The choice also sets the
  language the assistant replies in, unless you write to it in another
  language.
- Japanese, Chinese and Korean text is drawn with the platform's own font for
  that language rather than whichever font the browser happened to pick, so
  kanji are not rendered in Chinese letterforms.
- Dates, times, number grouping, file sizes and sorting now follow the language
  you picked rather than the machine's region. A German reader gets German
  month names and `2,5 MB`, not `2.5 MB`.

### Changed

- File sizes read `4.2 kB` rather than `4.2 KB`, and context windows read
  `200K` rather than `200k` — both are the standard forms for the reader's
  locale rather than hardcoded English.
- Settings panes no longer print their own name twice, and their forms are
  capped to a readable width instead of stretching a dropdown across the whole
  sheet to hold the word "Dark".

### Fixed

- Choosing a cloud provider while local-only mode was on left the app unable to
  answer anything: because local-only defaults to on and the default provider is
  a cloud one, a fresh install that followed setup as written failed on its
  first message with an error naming a setting the user had never seen.
  Choosing a cloud provider now turns local-only off, and says so.
- The first-run screen could render with its heading, step list and language
  picker above the top of the window, with no way to scroll up to them.
- Errors during first-run setup were silent. Testing a connection with no key
  saved, or a keychain write that failed, reported nothing at all.
- The allowed- and blocked-domain boxes showed a literal `&#10;` in their
  placeholder text in German, Spanish and French instead of a line break.
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

[Unreleased]: https://github.com/runningpixels/conduit/compare/v0.1.0-rc.5...HEAD
[0.1.0-rc.5]: https://github.com/runningpixels/conduit/compare/v0.1.0-rc.4...v0.1.0-rc.5
[0.1.0-rc.4]: https://github.com/runningpixels/conduit/compare/v0.1.0-rc.3...v0.1.0-rc.4
[0.1.0-rc.3]: https://github.com/runningpixels/conduit/compare/v0.1.0-rc.2...v0.1.0-rc.3
[0.1.0-rc.2]: https://github.com/runningpixels/conduit/compare/v0.1.0-rc.1...v0.1.0-rc.2
[0.1.0-rc.1]: https://github.com/runningpixels/conduit/releases/tag/v0.1.0-rc.1
