# Plan: UI revamp — activity rail, inspector, one composer menu

## Status

**Implemented — 2026-09-26**, branch `feat/ui-revamp` (all six phases).
English only: 69 new keys are listed in `i18n/pendingTranslation.json` for
the translation session. Design: the "E. Hybrid" boards on the revamp canvas
(claude.ai artifact "Conduit UI revamp"), chosen over four explored
directions (A Rail, B Quiet, C Spaces, D Deck).

As built, beyond the design above:

- The modal variants of Settings, Ideas and Documents remain in code
  (`variant="sheet"`, the default) with their tests; the app renders them as
  pages. They can go once nothing needs a modal.
- Activity's "This chat" summary lists the sites the chat's pages contacted
  this session (from the page network log), next to the turn's own steps.
- Chat status covers the one live request (the app runs one at a time).

## Why

The layout was modelled on Claude's desktop app when Conduit had chats and
artifacts. Since then it gained documents, ideas, skills, prompts, memory,
connectors, web search, image generation, a workspace agent, page network
access and themes, and each got a sheet, a sidebar item, a composer icon or a
Settings section wherever there was room:

- The composer carries up to nine conditional icon buttons.
- Documents and Ideas are modal sheets because the sidebar had no room.
- Settings is a 13-section modal that also hosts Connectors, Prompts, Skills
  and Memory — things you use, not configure.
- Tool calls render as cards in the transcript and push the answer down.
- The right panel only knows artifacts.

Research (September 2026): feature-dense apps converge on an activity rail
that swaps the sidebar (VS Code, Zed), progressive disclosure (Copilot's May
2026 redesign), the model picker in the composer (Open WebUI 0.11), one "+"
for tools (Perplexity, ChatGPT), and a visible but non-flooding activity
timeline (Claude Code desktop, Cursor Agents, AnythingLLM). Vendors are
removing extra top-level modes (ChatGPT Canvas, Claude Cowork merged back),
so this deepens existing columns instead of adding modes.

## Design

### Shell

```
┌────┬──────────────┬──────────────────────────────┬────────────────┐
│rail│ sidebar      │ main                         │ inspector      │
│56px│ (chats only) │ chat · or a destination page │ Page·Activity· │
│    │              │                              │ Sources        │
└────┴──────────────┴──────────────────────────────┴────────────────┘
```

- **Rail** (`shell/Rail.tsx`): Chats, Ideas, Documents, Library, Connectors,
  Memory; Settings at the bottom. Icons, or icons with labels
  (`data-rail="labels"`, an Appearance preference). Ideas carries the "new"
  dot. Keyboard: the rail is a toolbar (arrow keys move, Enter opens).
- **Destinations.** Chats shows the chat sidebar and the chat. Every other
  destination is a **page** in the main area (`shell/DestinationPage.tsx`),
  with the sidebar and inspector out of the way:
  - Ideas — the Ideas page (was a sheet).
  - Documents — collections (was a sheet; drag-and-drop still opens it).
  - Library — Prompts and Skills, as tabs (were Settings sections).
  - Connectors — (was a Settings section).
  - Memory — (was a Settings section).
  - Settings — the remaining configuration sections as a page with its own
    section list: Providers, Chat, Web search, Workspace, Appearance,
    Branding, Privacy & data, About (was a modal).
  Old deep links (`openSettings('connectors')`, palette commands, status line
  links) route to the new homes in one place, as `openSettings('knowledge')`
  already does for Documents.
- **Sidebar** keeps New chat, Search and the chat list; Documents and Ideas
  leave it (they are on the rail). Chat rows gain a status: *running* (a
  stream is live) and *needs you* (an approval, question or site permission
  is waiting).
- **Main head** keeps the chat title, chat menu and inspector toggle; the
  settings gear and its menu go (Settings is on the rail).

### Inspector (right)

`workspace/Inspector.tsx` hosts three tabs:

- **Page** — today's document panel, unchanged inside.
- **Activity** — the selected turn's steps as a timeline (tool, detail,
  status, duration; web searches; sites a page contacted), then a *This
  chat* summary (folder, sites, documents, cost). Built from the turns'
  `streamState`, plus the page network log.
- **Sources** — web search sources and document citations for the chat.

It opens when there is a page, or when the user opens Activity/Sources; it
stays closed on a new chat (the V9 "no empty panel" rule holds).

### Transcript

Each assistant turn shows one compact line — "2 steps · 1 site ›" — instead
of tool cards; it opens Activity for that turn. Anything that needs the user
(approvals, ask-user forms, errors) stays inline.

### Composer

One **+** menu holds Attach, Web search, Workspace folder, Documents, Skills,
Prompts (library and connector prompts), Resources and Chat settings. Active
context shows as removable chips above the input (folder, documents, skills,
web search). The model picker stays inside the composer; the status line
under it is unchanged.

### Theming

- Density (`data-density`: comfortable/compact) and rail style
  (`data-rail`: icons/labels) join look, palette and mode as appearance axes;
  both are token-driven, so every look and palette works with both.
- No new colours: every new surface uses existing semantic tokens.

## Phases

1. **Shell and destinations** — rail, destination pages, Settings as a page,
   sidebar trim, main head trim, deep-link routing, palette "Go to…".
2. **Composer** — "+" menu and context chips (Composer files only).
3. **Inspector and transcript** — tabs, Activity and Sources views, the
   compact step line, "open activity for this turn".
4. **Chat status** — running / needs you in the list.
5. **Theming** — rail labels preference, compact density tuned across the
   new surfaces, Appearance controls.
6. **Finish** — tests updated and added, live check (Playwright over CDP)
   in all looks, docs, changelog.

## Translation

New strings are added to `en.json` only and listed in
`i18n/pendingTranslation.json`; the completeness test skips listed keys (the
runtime already falls back to English). The translation session fills the
seven catalogs, stamps provenance and empties the list; a test fails if a
listed key is no longer in `en.json`.

## Risks

- **Muscle memory:** Settings, Documents and Ideas move. Deep links and the
  palette keep every old path working; the rail labels option helps.
- **Tests pinned to the old shell** (Settings sheet, sidebar nav, shell
  contract) need updating, not deleting — behaviour must be kept.
- **Inspector data:** hydrated turns must carry enough `streamState` for
  Activity; where they do not, Activity says so rather than showing nothing.
