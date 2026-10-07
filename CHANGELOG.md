# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0-rc.9] - 2026-10-07

### Added

- **Slides are built from their parts.** The assistant no longer writes a
  slide's HTML: it picks a layout and fills in its parts (headline, points,
  numbers with their labels, columns, a quote) and the app lays the slide out
  in the theme. Text that is too long for its place is sent back to the
  assistant with what to shorten, before the slide is made. A free-form layout
  remains for slides no layout fits.
- **Charts drawn from the numbers.** Bar, line and funnel charts are drawn by
  the app from the data the assistant gives: axes that start at zero, bars in
  proportion, labels that never collide, sizes readable from across a room.
  Diagrams the assistant draws itself are checked for tiny labels.
- **A layout check after each change.** After the assistant changes slides,
  the app looks at how they render. If text runs off, overlaps, crowds the
  footnote, or a diagram is unreadable, the assistant gets one round to fix
  exactly that; anything left is shown to you as a note. Text you wrote
  yourself is never changed by it.
- **Research rates its sources.** Each page is rated for credibility; a weak
  source is marked in the report's sources and its claims are attributed
  ("an unreviewed preprint claims…") or left out, never presented as
  established fact. Official, public-body and university sites are never
  rated low.
- **Research checks its own report.** A review pass checks every sentence
  against the facts it cites and the rest of the report, and corrects or
  removes what they don't support.

### Changed

- **Research knows today's date**, so "current" means now, and earlier events
  read as past. Figures that differ by year, edition, definition or units are
  explained rather than reported as disagreements; findings are shorter and
  say each point once; the brief's sub-questions don't overlap; an unanswered
  sub-question names the sites whose pages could not be read.
- **Usage & Cost counts every model call.** Research runs, workflow steps and
  chat turns without tools were missing from Usage & Cost and from the daily
  spend alert; they now count.
- The **+** menu says **Attach files…**, since documents attach too.

### Fixed

- **Tool calls run in the order the model wrote them.** With OpenAI-compatible
  providers (OpenAI, OpenRouter, DeepSeek, Groq and others), several tool
  calls in one reply ran in a random order: slides landed out of order and the
  assistant spent many extra steps moving them back.
- **Sent documents show as a file chip**, with their name and type, instead of
  a broken image in your message.
- A slide no longer shows the word "null" where the assistant meant to remove
  a label.
- A slide rejected for being too long keeps its place in the deck when the
  assistant retries it.

### Security

- Patched `lodash-es` (bundled with the diagram renderer), `undici` (test
  tooling only) and `source-map-js` (build tooling only) for the advisories
  Dependabot reported, including four rated high. Still open: `katex` 0.16
  inside the diagram renderer (low; moving it is a major upgrade for Mermaid)
  and `glib` 0.18 (Linux only, pinned by Tauri's GTK stack).

## [1.0.0-rc.8] - 2026-10-06

### Added

- **Attach documents to a message.** Drop a PDF, Word, text, Markdown or CSV
  file on a chat, paste it, or pick it with **+**, and the model reads it.
  Every model gets the document's text, extracted on your machine; models that
  read PDFs themselves (Claude, OpenAI, Gemini, and OpenRouter models that list
  file input) get the PDF, so charts and scanned pages come through too. Each
  attachment says how it will be sent, or why it won't be. In Chats, a drop
  anywhere on the chat attaches; elsewhere a drop still adds to Documents.
- **The assistant can read PDFs and Word files in an attached folder.**
  `workspace_read` used to refuse them as too large or binary; it now reads
  their text, a page of characters at a time.
- **Search in the model picker.** The model menu opens with a search field:
  type to narrow every provider's list, Enter takes the first match. Each
  provider's models are listed alphabetically, and the menu fits between the
  title bar and the composer however tall the list is.
- **Reasoning effort.** Chat settings (and Settings → Chat defaults) have a
  Reasoning effort choice: Auto, Low, Medium or High. Lower effort answers
  faster and costs less on thinking models; Auto leaves the model's default.
  It is sent only to models that accept it, mapped for OpenAI, OpenRouter,
  Anthropic and Gemini.
- **Daily spend alert.** Settings → Usage & Cost can alert you when today's
  estimated spend passes an amount you set. After a chat turn that crosses it,
  a notice shows the estimate and opens Usage & Cost; it appears once a day
  and never stops anything. Off by default. Days follow the usage chart (UTC).

### Changed

- **Claude prompts are cached.** Requests to Anthropic (and Claude models on
  OpenRouter and OpenCode Zen) mark the tools, the system prompt and the
  conversation so far for Anthropic's prompt cache, so a long chat no longer
  pays full input price for its history on every turn. Cache reads and writes
  are priced at their own rates in Usage & Cost.

- **Slides fit their text.** The slide themes shrink what doesn't fit, a step
  at a time down to a readable size, instead of letting it overlap or run off
  the slide: big stat numbers fit their column, long words fit their box, and
  a full slide eases its text and drawings until it fits. Exported HTML and PDF
  match what you see. A new full-width chart layout gives charts the whole
  slide.
- **Deck chats have fewer tools.** The calculator, UUID and random tools are no
  longer offered while editing a deck.

### Fixed

- **Slide headlines no longer get cut off at the top**, and a diagram beside
  the text no longer fills the whole slide height: the image-left layout keeps
  its drawing in its own column at its own shape.
- **Big decks finish building.** Adding slides now counts as progress against
  the turn's time limit, so a long build from a slower model is no longer cut
  off partway; and if a build still ends short, it continues once on its own
  with the slides that are missing.
- **New decks are titled "Untitled deck"** instead of an internal key, which
  the assistant was also shown as the deck's name.
- **DeepSeek models that read images now get them.** DeepSeek V4 Flash and its
  vision variant receive attached images instead of having them dropped;
  text-only DeepSeek models stay text-only.
- **The context gauge knows more models.** It now takes each model's context
  window from the bundled model catalog, so DeepSeek V4 shows its 1M window
  instead of 128K, and other catalog models show their real size too.

## [1.0.0-rc.7] - 2026-10-05

### Added

- **Writing.** A new area on the rail (`Ctrl+5`) for long pieces: blog
  posts, technical docs, reports, newsletters, essays.
  - Describe what you're writing; the assistant proposes an **outline**
    (sections, what each must say, a target length) that you edit and
    approve, then writes the draft section by section into a Markdown
    editor next to the chat. Each section appears in the editor as it is
    being written, and the draft keeps going until every section of the
    outline has text.
  - **Sources.** A draft can look things up on the web (off by default),
    draw on your document collections, or work from a finished
    **Research** report, whose quote-checked facts it prefers. Facts from
    a source are linked in the draft; anything without one is marked
    `[TODO]` instead of being made up. A finished Research card has
    **Write from this report**, and exports end with a Sources list.
  - **What you write stays yours.** Any paragraph you type or change is
    marked as yours, and the assistant keeps it word for word unless you
    ask it to change that text; "Let AI edit" hands it back.
  - Select text for **Rewrite, Shorter, Longer, Clearer, Fix grammar** or
    your own instruction. AI-written text can be shown tinted.
  - **History** keeps a version after every change the assistant makes
    and after your own editing, and restores any of them.
  - Export as Markdown or HTML.
  - Home gets a Writing tile, recent drafts under Pick up, and a **Write**
    chip in the ask box.

### Changed

- **Keyboard:** `Ctrl+5` now opens Writing; Documents, Library, Workflows
  and Connectors move to `Ctrl+6`–`Ctrl+9`. Memory is still on the rail,
  on Home and in the command palette.
- **Costs cover current models.** Prices now come from a snapshot of the
  open [models.dev](https://models.dev) catalog bundled with each release,
  about 790 models across every cloud provider Conduit supports, instead of
  a hand-kept table of 11 older models. Conduit never contacts models.dev
  itself. OpenRouter models use the price OpenRouter lists for them.
- **Your own prices.** Settings → Usage & Cost lets you set or correct the
  price of any model you have used, such as one behind a custom endpoint.
  Your price comes first, and it applies to past usage too.
- **Unpriced is not free.** A model with no known price shows *No price*
  instead of $0, and the total says how many models it leaves out.

### Fixed

- **Costs were 100 times too small.** Usage costs were computed in dollars
  and then displayed as cents. They are now right, and past usage is
  re-priced from its stored token counts, so the history is corrected
  too.
- **Cached prompts were counted twice.** On OpenAI, Gemini, OpenRouter and
  the other OpenAI-style providers, the input count already includes cache
  hits; those tokens were billed at both the input and the cache rate.
- **Approving an outline right after opening a draft could send the wrong
  stage.** A slower load of the draft could land after the approval and put
  it back to the outline stage, so the assistant was told it was still
  outlining. The newer copy of the draft now wins.
- **DeepSeek chats no longer fail after the first reply.** DeepSeek's
  models think before they answer, and when a request includes tools
  DeepSeek requires each earlier reply's thinking to be sent back in its
  own field, or it rejects the request. Conduit now sends it: the
  thinking from each tool round goes back as thinking, never as text, and
  earlier replies carry the field too. DeepSeek also accepts no
  "developer" messages, so Conduit's extra instructions (web search
  guidance, for one) now ride in the system message for DeepSeek.
- **Earlier thinking is no longer replayed as text to other providers.**
  When a tool round had to be rebuilt from the saved message, its
  reasoning went back to the model as if it had said it.
- **Hosted search can read the pages it finds.** With OpenRouter, OpenAI or
  Anthropic search, the model could find pages but not open them; it now
  gets the page-reading tool alongside the provider's search.
- **A later reply no longer calls earlier search results made up.** A reply
  that searched or read the web now says so in the history the next turn
  sees, so a follow-up without search doesn't mistake its cited findings
  for invented ones.
- **Asking to fix a page updates that page.** Requests like "clear the
  banner and put the cards in one row" now revise the existing page instead
  of writing a new one that lost the original's site permissions. "Build a
  one-page plan" now counts as making a document.
- **Home's Start a deck chip uses what you typed.** It starts a deck from
  the text in the ask box instead of opening an empty Slides page.
- **The inspector lists Research sources.** Its Sources tab shows a
  Research run's sources, cited ones first, instead of "No sources yet".
- **Waiting for you no longer uses up a turn's time.** Time spent on a tool
  approval or a question form doesn't count toward the turn time limit, so
  approving after a break carries on instead of ending the turn. While it
  waits, the status says "Waiting for your approval above" instead of
  "still working".

## [1.0.0-rc.6] - 2026-10-03

### Added

- **PDFs on the web are read.** Research, a workflow's Fetch page step and
  the model's page fetch now read PDFs (reports, budgets, papers) up to
  20 MB, the same way Documents imports one; a scanned PDF with no text
  counts as a page with nothing to read. On a long page or PDF, Research
  shows the model the opening plus the parts that match the questions,
  instead of only the first few pages.
- **Research.** Turn on Research in the composer's `+` menu (or pick it on
  Home) and ask a question that needs more than a quick search.
  - It first proposes a brief: the sub-questions it will answer, a scope,
    and a depth (Quick, Standard or Deep, each with its search, page and
    time limits). You edit and approve it before anything runs.
  - It then searches, reads the pages in full, and pulls out facts, each
    with the exact words from the page that support it. A fact counts only
    if those words are really on the page; the check is done by the app,
    not the model. It searches again for whatever is still unanswered.
  - The result is a report in your chat's documents: a summary, findings
    per sub-question, open questions, and a numbered list of sources, with
    every finding cited. The chat card shows the summary and how many
    sources were cited and read; Stop keeps what was found so far.
  - Page text only ever reaches a model call that has no tools, so a page
    that tries to give instructions can't make it search, fetch or save
    anything. Research needs web search turned on and isn't available in
    local-only mode.

### Security

- **Connector tools ask before they run unless they say they only read.**
  A tool from an MCP connector used to run without asking unless the
  connector declared it side-effecting with a field only Conduit reads, so
  tools on most third-party servers (writing files, sending messages,
  opening pull requests) ran unasked. Now a tool runs without asking only
  when it is marked read-only, by the standard MCP `readOnlyHint` or
  Conduit's own field; every other tool asks first. Connectors you already
  use may ask for tools that ran silently before; "Always" on the prompt
  remembers your answer, as before.
- **The model's page fetch no longer reaches your own network.** The
  `web_fetch` tool could be pointed at `localhost` or a private address, so
  a page could tell the model to read your router or another machine on
  your network. It now goes through the same checks as a workflow's Fetch
  page step: public https sites only, every redirect checked, with size and
  time limits. It also returns the page's title and readable text instead
  of raw HTML, which costs far fewer tokens; plain `http://` links are
  fetched over https.

### Fixed

- **A chat that searched a lot no longer stops without an answer.** After a
  turn's search limit, the search tool was taken away from the model; when
  it asked to search again anyway, those requests were dropped and the turn
  ended on whatever it had said so far ("Let me grab rental rates…"), with
  no answer and no error. Searches past the limit are now answered with
  "answer with what you have", and a model that ignores that twice ends with
  an error you can retry.
- **More searches per answer with a real search service.** With Exa,
  Tavily, Brave or SearXNG a turn can search 8 times (DuckDuckGo stays at
  3, since its empty results invite endless retries), and read 5 pages.
- **Search results show as sources.** Results from Exa, Tavily, Brave or
  SearXNG appear under each search in Activity and in Sources, and stay
  there when you reopen the chat. Before, every search said "0 sources".

## [1.0.0-rc.5] - 2026-10-03

### Changed

- **Saved apps are called personal apps.** The Apps page and the Home tile
  now say *personal apps*; the rail still says Apps.

- **Web search works on every model out of the box.** The local search
  backend now defaults to **Exa**, which returns real web results with no
  setup: it is free and rate-limited without a key, and an Exa key raises
  the limits. Queries go to Exa under its terms. Previously the default was
  DuckDuckGo's Instant Answer, which returns encyclopedia snippets and, for
  most searches, nothing. If you chose DuckDuckGo, it stays selected, and
  Settings → Web search offers a one-click switch to Exa.
- **OpenRouter has built-in web search.** With OpenRouter as the provider,
  search runs through OpenRouter's own web search, billed to the same key,
  and its sources and citations show up like any other provider's.

### Added

- **Get a search key in one click.** Settings → Web search has a link to
  get a key from Exa, Tavily or Brave, and to SearXNG's setup guide, each
  opening in your browser.

## [1.0.0-rc.4] - 2026-10-02

### Added

- **Home.** The app now opens on a Home page, first on the rail.
  - One ask box to start anything: ask for a deck and Slides opens with a
    storyline; anything else starts a chat. Quick starts sit underneath.
  - **Needs you** lists workflow approvals, workflow questions and memory
    suggestions waiting on you; it is hidden when nothing is.
  - **Pick up where you left off** shows your latest chats, decks and apps.
  - Every area of the app as a tile with a live count. An empty area shows an
    example to try; where the ask box can run it, a click puts it there.
  - A few ideas that work with your setup.
- **Go anywhere from the keyboard.** `Ctrl+1` to `Ctrl+9` (`⌘` on macOS) open
  Home, Chats, Apps, Slides, Documents, Library, Workflows, Connectors and
  Memory, and the command palette (`Ctrl+K`) has a "Go to" entry for each.

### Fixed

- **Remote connectors on the 2025 protocol connect again.** A server that
  refuses the newest MCP protocol version with an HTTP 400 (DeepWiki, for
  one) now gets the older handshake it supports, instead of showing as
  down.
- **A chat opened from another page starts at its latest message.** It could
  stop short when the conversation finished laying out after the jump to the
  bottom.
- **The Pitch deck idea opens in Slides.** It used to build a single HTML
  page in a chat; now it opens Slides with the story filled in, ready to
  start as a real deck.
- **Connector search tries again before it gives up.** A search of the
  official MCP registry that hits a network error, a timeout or a busy
  server is retried once, so a first search on a cold connection no longer
  fails.

## [1.0.0-rc.3] - 2026-10-02

### Added

- **Slides.** A new **Slides** section for presentations you build by
  asking. Describe the story (or ask for a deck in any chat) and the
  assistant drafts a storyline you approve, then builds the slides into one
  live deck: no new copy of the file for every change. The deck opens in a
  studio with the slide large in the middle and the chat beside it.
  - Ask for targeted changes; the assistant edits one slide at a time, or
    swaps a word across the whole deck.
  - **Script** shows every word of the deck as one document; type there or
    double-click text on a slide. Text you write is kept when the assistant
    rewrites a slide, unless you ask it to change that text.
  - **History** keeps a version for every change, labelled by your request,
    to restore at any time.
  - Two built-in themes, plus any theme the assistant designs for you.
  - **Present** full screen, with a separate presenter view (current and next
    slide, speaker notes, timer) to keep private while you share the slides.
  - **Export** as a single HTML file that presents itself in any browser, or
    as a PDF (Windows).
  - This version adds to your local database. If you later go back to
    rc.2 or earlier, that version can't read it and starts with an empty one
    (the old file is kept as a backup).

### Fixed

- **Provider names on Documents and in Settings.** The Documents page, the
  indexing consent dialog and the usage table showed a provider's internal id
  ("openrouter") instead of its name ("OpenRouter").

## [1.0.0-rc.2] - 2026-10-01

### Added

- **App settings.** Every saved app has a **Settings** page (the gear in the
  app's header, or ⋯ → Settings); the app keeps running behind it.
  - **Model:** choose which model answers the app's *Main* and *Quick*
    requests, or let them follow your active model. Only providers you've set
    up are offered. Switching to a new provider asks for permission again.
  - **Usage:** tokens per day for the last week, and a **daily limit for
    cloud models** (100,000 tokens by default). Past it, the app's model
    requests stop until midnight. Models on this computer are never limited.
  - **Data:** what the app keeps, key by key, with **Export data** (a JSON
    file) and **Clear data**.
  - **Permissions:** the sites and model providers the app may use, each one
    revocable.
  - **Activity:** a week of one-line records of the app's model requests, site
    requests and saved-data changes. Prompts, replies, addresses and saved
    values are never recorded.
- **Starter apps speak your language.** The eight starter apps show their text
  in the interface language, with numbers, dates and currencies formatted to
  match. The weather app's **Inputs** form is translated too.
- **Apps can ask for a quick model.** A page may mark a request as quick
  (short and cheap); it uses the app's *Quick* model.

### Changed

- **Byte sizes read naturally** ("100 bytes", was "100 byte").
- **Unit converter** accepts either decimal mark (2,5 or 2.5) and writes
  your language's own.
- **Updated dependencies,** including Tauri 2.12, React 19.3, Mermaid 12 and
  react-intl 12.

### Fixed

- **White-label branding on the new design.** The Branding form starts from
  the current colours instead of the retired theme's; a brand's main colour
  now reaches every accent (glows, tiles, hovers) instead of only some; and
  turning branding on loads your `brand.md` into the form, while turning it
  off no longer leaves the window branded.
- **Word documents keep their special characters** ("R&D", "Café") when
  added to Documents.

### Security

- **WebRTC is off in pages on Linux.** The webview now starts with WebKitGTK's
  WebRTC setting off, so a page's script can't open a WebRTC connection. On
  Ubuntu's WebKitGTK it was never available; this covers distributions whose
  WebKitGTK includes it.
- **Known issue: WebRTC on macOS.** Blocking WebRTC in pages still relies on
  the page's own script on macOS, which has no webview setting for it.

## [1.0.0-rc.1] - 2026-09-30

### Added

- **Apps.** Keep a page the assistant built: **Save as app** in the page's ⋯
  menu makes a copy you open from **Apps** on the rail, or from **Your apps**
  on the new-chat screen, and it keeps working after you delete the chat.
  Saving asks which of the page's site permissions to keep, one by one, and
  keeps none you don't tick. An app shows what it can reach in a status line
  Conduit draws outside the page; when the chat's page changes, the app offers
  **Update**. Rename, change the mark and category, or delete an app from its
  ⋯ menu.
- **Eight starter apps**, built in: a Pomodoro timer, a unit converter, Snake,
  a memory game, a world-capitals quiz, a budget tracker, and a weather
  dashboard and a currency converter that use live data (and ask before they
  connect). Add one from Apps, or press **Open app** on an idea that has one.
  A starter you added stays up to date with the version Conduit ships.
- **Pages can keep data.** A page or an app can store a little data between
  launches (up to 5 MB each), so a tracker keeps its entries. Saving a page as
  an app takes its data along. An app's status line shows how much it keeps,
  and **Clear data** removes it.
- **App settings.** A page can declare a few settings — a city, units — and
  Conduit draws the form behind an **Inputs** button. Changing them updates the
  running app without reloading it. The weather dashboard uses this for its
  city and units.
- **Pages can ask your AI model.** After you allow it for that page, a page or
  an app can send your model a prompt and get the answer back. The prompt
  names the provider and says when text would leave your device; allow it this
  once, always for that page, or not at all. The page gets text in and text
  out: no tools, chat history, memory or documents, and it never learns which
  model answered. Switching providers asks again; **Stop model access** turns
  it off for an app.
- **Ideas on the new-chat screen.** Things to try, by category, under the
  message box; picking one fills in the prompt. Your most recent apps sit above
  them.

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
  back to an answer you set. A "Let the model use tools" step lets the
  model search the web, read pages, check the time or do arithmetic before
  it answers; a scheduled run asks you to approve those tools first. The
  summarize step still gets no tools.
- **Leave a document out of a chat.** In the composer's Documents menu, an
  attached collection expands to list its documents; untick one and that
  chat stops searching it, without deleting it. Documents added to the
  collection later are included automatically.
- **Point at a document with `#`.** Type `#` in the message box to pick any
  document by name, shown with its collection. That message searches only
  the documents you picked, even from collections the chat hasn't attached,
  and the sent message keeps showing what it referenced.

### Changed

- **A new look, in two modes.** One design, dark or light (or following your
  system), replaces the theme gallery and theme files. The rail is labeled and
  carries the name and mark; Ideas moved to the new-chat screen. You can still
  pick the main colour, per mode, in Settings → Appearance. If you used a theme
  that was only dark or only light, Conduit keeps that mode. Theme files you
  added are left on disk but no longer used.
- **The first few steps of a turn show as rows**, with the rest in the summary
  line.

### Security

- **Pages can't reach the app's own commands.** On Windows, the webview also
  loaded the app's internal command channel into every page's frame. The app
  already refused every call from a page, and now each page cuts that channel
  before any of its own script runs.
- **Known issue: WebRTC on macOS and Linux.** Blocking WebRTC in pages is done
  in the Windows webview only. On macOS and Linux a page's script could still
  reach a host through STUN/TURN; the fixes there haven't been built and
  verified yet.
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

[Unreleased]: https://github.com/runningpixels/conduit/compare/v1.0.0-rc.9...HEAD
[1.0.0-rc.9]: https://github.com/runningpixels/conduit/compare/v1.0.0-rc.8...v1.0.0-rc.9
[1.0.0-rc.8]: https://github.com/runningpixels/conduit/compare/v1.0.0-rc.7...v1.0.0-rc.8
[1.0.0-rc.7]: https://github.com/runningpixels/conduit/compare/v1.0.0-rc.6...v1.0.0-rc.7
[1.0.0-rc.6]: https://github.com/runningpixels/conduit/compare/v1.0.0-rc.5...v1.0.0-rc.6
[1.0.0-rc.5]: https://github.com/runningpixels/conduit/compare/v1.0.0-rc.4...v1.0.0-rc.5
[1.0.0-rc.4]: https://github.com/runningpixels/conduit/compare/v1.0.0-rc.3...v1.0.0-rc.4
[1.0.0-rc.3]: https://github.com/runningpixels/conduit/compare/v1.0.0-rc.2...v1.0.0-rc.3
[1.0.0-rc.2]: https://github.com/runningpixels/conduit/compare/v1.0.0-rc.1...v1.0.0-rc.2
[1.0.0-rc.1]: https://github.com/runningpixels/conduit/compare/v0.1.0-rc.8...v1.0.0-rc.1
[0.1.0-rc.8]: https://github.com/runningpixels/conduit/compare/v0.1.0-rc.7...v0.1.0-rc.8
[0.1.0-rc.7]: https://github.com/runningpixels/conduit/compare/v0.1.0-rc.6...v0.1.0-rc.7
[0.1.0-rc.6]: https://github.com/runningpixels/conduit/compare/v0.1.0-rc.5...v0.1.0-rc.6
[0.1.0-rc.5]: https://github.com/runningpixels/conduit/compare/v0.1.0-rc.4...v0.1.0-rc.5
[0.1.0-rc.4]: https://github.com/runningpixels/conduit/compare/v0.1.0-rc.3...v0.1.0-rc.4
[0.1.0-rc.3]: https://github.com/runningpixels/conduit/compare/v0.1.0-rc.2...v0.1.0-rc.3
[0.1.0-rc.2]: https://github.com/runningpixels/conduit/compare/v0.1.0-rc.1...v0.1.0-rc.2
[0.1.0-rc.1]: https://github.com/runningpixels/conduit/releases/tag/v0.1.0-rc.1
