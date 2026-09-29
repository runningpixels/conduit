# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Workflows.** A new Workflows page runs routines for you: fetch pages,
  search the web, have the model summarize, and save the result as a
  document. Start from a ready-made one (a morning briefing, a page
  summary, a topic watch), change what it fetches each time you run it,
  and open any run to see what each step did. Build your own in the step
  editor: add steps, reorder them, and pick what each step reads from a
  menu of earlier results (shown as chips in the text), with problems
  shown before you save. Open the document a run saved straight from the
  run. Schedule a workflow to run every day or on weekdays at a set time,
  or every few hours, and get a notification when it finishes; a run
  missed while Conduit was closed happens once when you open it. To keep
  schedules running with the window closed, Conduit can stay in the tray
  (offered once, the first time you switch a schedule on) and start in the
  tray when you sign in; both are off by default. Opening Conduit again
  while it's in the tray brings the window back. Stop a run in progress
  from its page, or every run from the tray menu, which shows how many are
  running; quitting mid-run asks first, and a stopped run is kept, marked
  as stopped. Turning a schedule on first shows everything the workflow
  will be allowed to do on its own (the sites it reads, web search, which
  model, saving documents) for you to approve. A scheduled run that needs
  more, after an edit or a settings change, pauses and asks: allow once,
  always allow, or don't allow. Each run has a time and token limit. A
  site or model that fails for a moment is tried again (twice for pages
  and searches, once for the model; choose per step), and a reply that
  should be JSON but isn't gets one more ask. A new step shows a desktop
  notification with text from earlier steps. Fixed a later step? Rerun
  from it: the steps before it aren't run again, their earlier results are
  reused, and the run keeps the values it started with. An "Ask me" step
  stops to ask you something, with answers to pick from or a box to type
  in, and the next steps use your answer; if nobody answers, it can fall
  back to an answer you set. Only the summarize step uses the model, and it
  can't use tools.
- **Leave a document out of a chat.** In the composer's Documents menu, an
  attached collection expands to list its documents; untick one and that
  chat stops searching it, without deleting it. Documents added to the
  collection later are included automatically.
- **Point at a document with `#`.** Type `#` in the message box to pick any
  document by name, shown with its collection. That message searches only
  the documents you picked, even from collections the chat hasn't attached,
  and the sent message keeps showing what it referenced.

### Security

- **HTML artifacts can't send data out through WebRTC.** The page's content
  security policy never covered WebRTC, so a page's script could reach any
  host through STUN/TURN even with network access off. Release builds
  weren't exposed, because they currently block artifact scripts entirely
  (a separate bug). This closes the hole before artifact scripts are
  re-enabled: on Windows it is blocked in the webview itself, and pages can
  no longer create WebRTC connections. If you allow remote images, fonts or styles from specific
  sites (Settings → Artifacts), changes to that list now apply after a
  restart.

### Fixed

- **Workflows and other pages no longer show a stray line on hover.** The
  chat's resize handles sat above pages drawn over the chat, so hovering
  lit an invisible line mid-page and dragging it resized the hidden
  sidebar.
- **A workflow run cut off by quitting no longer stays "running" forever.**
  On the next launch it's marked failed, with the reason.
- **Text boxes and dropdowns stand out from the page.** Their outline was
  barely darker than the background, so in the dark themes a field could
  look like empty space. Every theme now draws them with a clearly visible
  border, and a focused text box is easier to spot.
- **Interactive HTML artifacts work in installed builds.** Released builds
  blocked every script inside an HTML artifact, so calculators, charts,
  games and live-data pages showed only their static layout. Artifacts now
  load from their own sandboxed address, and their scripts run as intended.
- **Dropping a file on the message box attaches it on Windows.** Dropping
  anywhere else on the window still adds it to Documents. Conduit reads
  only files that were actually dropped on the window.
- **Retry retries.** The Retry button under a reply used to only delete it.
  It now asks again with the same question, attachments and referenced
  documents, and replaces the reply. It appears on the last reply only.
- **Japanese, Korean and Chinese input:** the Enter that confirms a
  conversion no longer sends the message.

## [0.1.0-rc.8] - 2026-09-27

### Added

- **The new layout in every language.** The side rail, the inspector, the
  composer's "+" menu, the redesigned pages and the network dialog are now
  translated into German, Spanish, French, Japanese, Brazilian Portuguese,
  Korean and Simplified Chinese. With **Side rail → Icons and labels**, a long
  label wraps onto a second line instead of being cut off.
- **Let a page reach any public site.** The network dialog has a
  **Let this page reach any public site** option, for this time or always,
  for pages that use many services. Every request still goes out without your
  cookies or sign-ins, is logged, and can never reach your computer or local
  network; local-only mode and the Settings switch still turn it off.

### Changed

- **Ideas, Documents, Library, Connectors and Memory pages redesigned.** Each
  has the same header — what the page is for, its main action on the right,
  and the longer explanation behind **How this works** — and uses the whole
  window. Documents lists your collections beside the one you picked, now
  showing the files inside it; Library shows a prompt or skill in full
  beside the list; Connectors shows a server's tools, prompts, resources and
  permissions beside the list; Memory puts suggestions waiting for you first.
  Ideas lists its categories on the left and fills the rest with ideas.

### Fixed

- **A page whose site moved keeps working.** When a site a page was allowed
  to use redirects to another one (api.frankfurter.app now sends requests to
  api.frankfurter.dev), Conduit asks about the new site instead of leaving
  the page without its data; allowing it resends the request. Redirects
  within the same site are followed without asking.

## [0.1.0-rc.7] - 2026-09-26

### Added

- **A new layout.** A side rail on the left takes you to Chats, Ideas,
  Documents, Library (your prompts and skills), Connectors, Memory and
  Settings; each is a full page instead of a pop-up, and a reply you are
  waiting on keeps running while you look. Settings keeps what you configure
  (providers, chat, web search, workspace, appearance, branding, privacy,
  about); the rest moved to the rail. **Settings → Appearance → Side rail**
  shows labels under the icons. Text that is new in this layout is in English
  for every language until the next translation pass.
- **The inspector.** The panel beside the chat now has three tabs: **Page**
  (the document or page, as before), **Activity** (every tool call, web
  search and site a turn used, with how long each took) and **Sources**
  (web sources and document citations). Instead of a card per tool call, a
  reply shows one line — "2 steps · 1 site" — that opens its Activity;
  anything that needs you, like an approval or a question, still appears in
  the chat.
- **One "+" in the composer.** Attach, web search, the workspace folder,
  documents, skills, connector prompts and resources, and chat settings are
  behind a single button; what is on for the chat shows as chips above the
  message, each removable.
- **Chat status.** The chat list shows which chat is running, or waiting on
  you, even while you are in another chat.

- **Ideas.** A new page on the side rail with things to try — a pomodoro timer,
  a live weather dashboard, flashcards, a Snake game, a logo — grouped by what
  you want to do. Each one starts a chat with the prompt filled in so you can
  change it before sending. Ideas that need something you haven't set up say
  what, and take you there; ideas this setup can't run (live data in
  local-only mode) stay out of the way. New chats show three ideas under the
  greeting until you've found your feet, onboarding ends with three to try,
  and a follow-up suggestion now and then points at something the reply could
  become ("Make it a dashboard", "Use live data"). What you've tried is
  remembered on this device only.

- Pages that fetch live data. An HTML page can now call public web APIs — a
  weather dashboard can show today's forecast instead of a made-up sample. The
  first time a page asks for a site, a banner names it; **Review** shows why
  the page says it needs the site, the request it is making and any data it
  would send. Allow it this once, always for that page, or not at all. The
  globe button above the page lists every site it declares or contacted, with
  each request. Requests go through Conduit rather than the page: https only,
  without your cookies or saved logins, never to your local network, and size-
  and rate-limited. The site does see your IP address. Local-only mode refuses
  every request, and **Settings → Artifact security** can turn the feature off
  and remove remembered permissions.

### Fixed

- **Local-only mode now blocks cloud providers in every chat.** It already
  switched off web search and cloud document indexing, but a chat that used
  tools — which is most chats, since the built-in tools are on by default —
  could still be answered by a cloud provider you had selected before turning
  local-only mode on. Every chat round, and the automatic summary that keeps a
  long conversation within the model's limit, now refuses a cloud provider while
  local-only mode is on; only a local provider such as Ollama or LM Studio can
  answer. The description under Settings → Privacy & data said the opposite and
  has been corrected in every language.

- Forms in HTML pages work. A search box, an "add item" form or a calculator
  built as a form did nothing when you pressed its button or Enter, because the
  page's sandbox blocks form submission before the page's own code hears about
  it. The page now gets the submit as it expects; nothing is sent anywhere.

## [0.1.0-rc.6] - 2026-09-22

### Added

- Your own documents, searchable from a chat. **Documents** in the sidebar is
  where you create a collection and add files to it — plain text, Markdown, CSV,
  Word documents and PDFs — or drag files from your desktop anywhere onto the
  window. Adding a large document shows its progress as it is indexed. Attach a
  collection to a chat from the composer and the assistant searches it while
  answering. Under your message, each document it drew on is named with the
  sections it used; click one to read the exact passage.

  Search combines two methods, because they fail in different places: one finds
  passages that mean the same thing as your question even when the words differ,
  the other finds exact terms like error codes, names and jargon that the first
  one is bad at.

  Indexing a document sends its text to the provider that embeds the collection,
  so you are asked before the first document goes to a given provider, and the
  dialog says plainly that the provider sees the complete contents of each file.
  Consent is remembered per provider, so agreeing to send documents to one does
  not quietly authorise another, and you can withdraw it from Documents at any
  time. Declining leaves the document unindexed and tells you so. With
  local-only mode on, a collection needs a local provider such as Ollama, and
  says why rather than falling back to the cloud.

  PDFs are read on your computer, not uploaded to be read, and a one-time notice
  explains that before the first one — including that a scanned PDF with no text
  layer will yield nothing. When a file cannot be read, the message names the
  actual reason: scanned, too large, unreadable, or took too long.

  A retrieved passage that looks like it is trying to issue instructions is
  refused and named rather than quietly handed to the model, the same rule
  connector resources already follow. If a collection cannot be searched for a
  turn — its provider lost its key, or local-only is on — you are told which one,
  instead of just getting a worse answer.

  Until you create a collection, the chat itself is unchanged: no new button in
  the composer, no dialog, and no extra work on any message you send.

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

### Fixed

- A saved prompt with variables — `{{name}}`, `{{language}}` — now asks you to
  fill them in when you insert it. Previously it went into the composer with the
  braces still in, for you to find and replace by hand.

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

[Unreleased]: https://github.com/runningpixels/conduit/compare/v0.1.0-rc.8...HEAD
[0.1.0-rc.8]: https://github.com/runningpixels/conduit/compare/v0.1.0-rc.7...v0.1.0-rc.8
[0.1.0-rc.7]: https://github.com/runningpixels/conduit/compare/v0.1.0-rc.6...v0.1.0-rc.7
[0.1.0-rc.6]: https://github.com/runningpixels/conduit/compare/v0.1.0-rc.5...v0.1.0-rc.6
[0.1.0-rc.5]: https://github.com/runningpixels/conduit/compare/v0.1.0-rc.4...v0.1.0-rc.5
[0.1.0-rc.4]: https://github.com/runningpixels/conduit/compare/v0.1.0-rc.3...v0.1.0-rc.4
[0.1.0-rc.3]: https://github.com/runningpixels/conduit/compare/v0.1.0-rc.2...v0.1.0-rc.3
[0.1.0-rc.2]: https://github.com/runningpixels/conduit/compare/v0.1.0-rc.1...v0.1.0-rc.2
[0.1.0-rc.1]: https://github.com/runningpixels/conduit/releases/tag/v0.1.0-rc.1
