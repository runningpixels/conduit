# UI improvements — resizable sidebar, top-bar settings, and follow-ups

Status: **PR 1** (#42), **PR 2** (#43) and **PR 3** (narrow-window overlays) implemented; PRs 4–6 proposed · Branch: `feat/ui-improvements` · Drafted 2026-09-13

Two asks from dogfooding, plus what a pass over the running shell turned up:

1. The left pane (conversation sidebar) is fixed at 280px and cannot be resized.
2. Settings sit 2–3 clicks deep behind the sidebar's footer chip. Add a top-bar entry point.
3. Other improvements, found by driving `dev:web` in Chrome and by looking at how comparable
   desktop apps handle the same problems.

---

## 1. Where things stand today

### Layout

- The shell is two grid rows: the 32px caption row (`TitleBar`, `--titlebar-h`), then `.body`.
- `.body` is `grid-template-columns: var(--sidebar-w) minmax(0,1fr) 12px var(--panel-w)`
  (`apps/desktop/src/styles/workspace.css:167`). Tokens default to `--sidebar-w: 280px` and
  `--panel-w: 420px` (`packages/ui/src/tokens.css:144-145`).
- Collapsing a column is a width animation, driven by `html[data-sidebar]` / `html[data-panel]`
  (`workspace.css:170-171`) with `transition: grid-template-columns .22s`.
- **The document panel is already resizable.** `useColumnResize()` in
  `apps/desktop/src/workspace/useLayout.ts:62-137` handles pointer capture, arrow/Home/End keys,
  a clamp of `[280, min(560, innerWidth-320)]`, and saves to `localStorage['conduit:v5-layout']`
  as `{panelW}`. The handle is a 12px grid track, `App.tsx:1333-1345`.
- **The sidebar is not resizable.** `.sidebar-inner { width: var(--sidebar-w); min-width: 280px }`
  (`workspace.css:185`). There is no handle, and nothing writes `--sidebar-w`.
- Measured at 1440×900: 32px caption row, then a 46px `MainHead`, which puts 78px of chrome above
  the thread. On Windows the caption row holds only the window controls. In `dev:web` and on
  macOS it is empty.

### How settings are reached

`SettingsSheet` is a modal overlay. It takes `initialSection` for deep links and has 12 sections:
providers, chat, web-search, workspace, connectors, prompts, skills, memory, appearance,
branding (gated), privacy, about.

| Path | Clicks | Lands on |
| --- | --- | --- |
| Sidebar footer chip ("workspace · local only") → **Settings** | 2 | `appearance` |
| Chip → Providers & keys / Connectors / Privacy & data | 2 | that section |
| `Ctrl+,` | 0 (hotkey) | `providers` |
| `Ctrl+K` → `>set` → Open settings | 3+ typed | `providers` |
| Status line under composer → key posture / local-only row | 2 | `providers` / `privacy` |

Settings are filed under a chip labelled with the **workspace** name. Nobody would look there
for Appearance.

### Defects found while driving the shell

| # | Defect | Evidence |
| --- | --- | --- |
| B1 | The chip menu's **Settings** item shows the `Ctrl+,` hint, but the item opens *Appearance* while `Ctrl+,` opens *Providers*. | `Sidebar.tsx:602` passes `'appearance'`; `App.tsx:1044-1047` defaults to `'providers'` |
| B2 | With the sidebar collapsed, the mouse cannot reach **Settings, New chat, or Search**. The only control left is the floating `.sb-reveal`. | Observed at 1440px with the sidebar collapsed |
| B3 | Below 900px the sidebar is force-collapsed with `!important`, but `data-sidebar` stays `"open"`, so `.sb-reveal` never shows. Toggling with `Ctrl+\` flips the attribute but the column stays at 0. **The mouse cannot reach any chat.** | `workspace.css:644-646`. The CSS comment calls the overlay "a follow-up affordance". |
| B4 | Dragging the doc-panel handle lags the pointer because the 220ms `grid-template-columns` transition keeps running during the drag. | Set `--panel-w` to 520: the track still reads 420 one frame later and reaches 520 only after about 220ms |
| B5 | Breakpoints disagree. JS turns resize off below **820px**, CSS hides the panel handle below **1100px** and collapses both columns below **900px**. | `useLayout.ts:77,107` vs `workspace.css:638-648` |
| B6 | The sidebar context menu opens on right-click only, has no arrow-key navigation, no focus on open, and no clamp to the viewport (it overflows near the bottom edge). It also has no **Rename**, which exists only in the palette. | `Sidebar.tsx:302-306, 624-708` |
| B7 | The window title is never set, so the taskbar and Alt-Tab always show "Conduit". | No `setTitle` / `document.title` anywhere in `src/` |

---

## 2. What other apps do (research notes)

- **Resizable sidebars.** The usual set is: drag the edge with a `col-resize` cursor, clamp to a
  min/max, **double-click the sash to reset**, **drag below a threshold to snap-collapse**, keep the
  width across reloads, and support the keyboard per the WAI-ARIA *window splitter* pattern.
  `react-resizable-panels` collapses a panel once it is dragged below half its `minSize`. The
  shadcn resizable sidebar lets a click on the rail toggle collapse.
  ([react-resizable-panels](https://github.com/bvaughn/react-resizable-panels),
  [shadcn-resizable-sidebar](https://github.com/lumpinif/shadcn-resizable-sidebar),
  [UX Planet: sidebar practices](https://uxplanet.org/best-ux-practices-for-designing-a-sidebar-9174ee0ecaa2))
- **Windows title bar guidance.** The standard bar is 32px. All empty or non-interactive space must
  stay draggable. Double-click maximises, right-click opens the system menu. App controls are
  allowed, and the bar grows to 48px when it holds a search box or account picture.
  ([Microsoft Learn: title bar design](https://learn.microsoft.com/en-us/windows/apps/design/basics/titlebar-design))
- **VS Code.** The title bar carries layout toggles for the sidebars and panel, plus a
  *Customize Layout* dropdown. Account and **Manage (gear)** move into the title bar when the
  activity bar is hidden. The gear is a menu: Command Palette, Settings, Keyboard Shortcuts,
  Themes, Check for Updates.
  ([VS Code custom layout](https://code.visualstudio.com/docs/configure/custom-layout))
- **Claude Code desktop (April 2026 redesign).** A session sidebar with filter and group-by, panes
  you resize by dragging their edges, `Ctrl+/` for a keyboard-shortcuts sheet, a usage indicator
  in the header, and view-density modes. An open issue asks for chat text size separate from UI
  zoom.
  ([Anthropic blog](https://claude.com/blog/claude-code-desktop-redesign),
  [claude-code#50543](https://github.com/anthropics/claude-code/issues/50543))
- **LM Studio.** `Ctrl+L` opens the model picker from anywhere, so a global hotkey stands in for
  hunting through menus. ([LM Studio 0.4.0](https://lmstudio.ai/blog/0.4.0))
- **Searchable settings.** A recurring request for Cursor. A reference implementation offers fuzzy
  matching, breadcrumbs, and a jump-to-row with highlight.
  ([Cursor forum](https://forum.cursor.com/t/make-cursor-settings-searchable/61682),
  [traycer PR #1840](https://github.com/traycerai/traycer/pull/1840))

---

## 3. Part 1: Resizable sidebar

### Behaviour

| Interaction | Behaviour |
| --- | --- |
| Drag the sidebar's right edge | Width follows the pointer live, clamped to `[220, SIDEBAR_MAX]` |
| Drag below `220 / 2 = 110px` | Snap-collapse (`data-sidebar="closed"`). Reopening restores the width the drag *started* from, not the min it passed through on the way out. Dragging back out mid-gesture reopens it. |
| Double-click the handle | Reset to 280px |
| Focus the handle, then ←/→ | Arrows move the separator: ±10px, or ±50px with Shift. Home = min, End = max. The doc panel's arrows now move its separator too, so ← widens it; before this PR they were inverted. There is no Enter-to-collapse: a collapsed sash is hidden, so focus would be lost with no way back from the handle. |
| Window resize | Re-clamp both columns so the thread keeps `THREAD_MIN` (see below) |
| Reload | Width restored in a layout effect before first paint. The collapse attributes moved to layout effects too, so a stored "closed" no longer animates shut on launch. |
| Press without moving | Persists nothing, so clicking the sash cannot save a viewport-clamped width as the preference |
| < 900px | Resize is off. The sidebar becomes an overlay (Part 3, P1-a). |

**Clamp.** `SIDEBAR_MAX = min(480, innerWidth − openPanelWidth − 12 − THREAD_MIN)` with
`THREAD_MIN = 420`. The panel clamp becomes the mirror image and subtracts the open sidebar width.
Today `panelMax()` assumes a fixed 320px for everything else. That was true while the sidebar
could not move, and it stops being true once it can.

### Implementation

1. **Generalise the hook** (`workspace/useLayout.ts`)
   - Extract `useResizableColumn({ cssVar, storageField, min, max(), defaultPx, edge })`, where
     `edge: 'left' | 'right'` picks between `clientX` and `innerWidth − clientX`.
   - Rebuild `useColumnResize()` on top of it for the doc panel, so `App.tsx` and
     `useLayout.test.ts` keep their API.
   - Add `useSidebarResize()`, tied to `useSidebarCollapse()` for the snap-collapse.
   - One `resize` listener (throttled with rAF) re-clamps both columns.
   - Put the breakpoints in shared constants (`NARROW_BREAKPOINT = 900`, `PANEL_BREAKPOINT = 1100`)
     and read them in both JS and a CSS comment. The JS `matchMedia` checks use these constants
     (fixes **B5**).
2. **Storage.** Keep the `conduit:v5-layout` key and **merge-write** `{ panelW, sidebarW }`.
   `writeStoredPanelWidth` currently overwrites the whole object, which would wipe `sidebarW`.
   Existing `{panelW}` values still load, so no migration is needed.
3. **CSS variables** (`workspace.css`, `tokens.css`)
   - New `--sidebar-open-w` (set inline on `<html>`, default 280px) and `--sidebar-min: 220px`.
   - `.body { --sidebar-w: var(--sidebar-open-w) }`, while `html[data-sidebar="closed"] .body`
     still sets `--sidebar-w: 0px`.
   - `.sidebar-inner { width: var(--sidebar-open-w); min-width: var(--sidebar-min) }`, so the
     content keeps its open width while the column animates shut (the reason for today's
     hardcoded 280).
4. **Handle markup** (`App.tsx`). Do not add another 12px grid track, because that would shift
   the thread and change the V9 proportions. Instead, overlay an 8px hit zone on the sidebar's
   border: `.body { position: relative }` and `.sidebar-resize { position: absolute;
   left: calc(var(--sidebar-w) - 4px); width: 8px }`. It reuses the `::after` hue line from
   `.resize-handle`. It is hidden when `data-sidebar="closed"` or below 900px.
   - Include `role="separator"`, `aria-orientation="vertical"`, `aria-controls` pointing at the
     sidebar id, and `aria-valuenow/min/max` (in percent, matching the panel handle).
   - Wait 150ms on hover before showing the hue line, so it does not flash as the pointer crosses.
5. **No lag during drags (B4).** While dragging, set `html[data-resizing]` in place of
   `body.style.cursor/userSelect`:
   `html[data-resizing] .body { transition: none }` and
   `html[data-resizing] * { cursor: col-resize !important; user-select: none }`.
   This fixes both handles.
6. **Narrow-width content.** Measured at 220px under en, en-XA and de. The nav `kbd` hints and
   the footer chip fit, so no container query was needed. The one real overflow was `.ws-menu`,
   whose inherited 216px `min-width` overhung the column and got clipped. It now sizes by its
   insets. `layout/sidebarResize.spec.ts` guards this, and fails if the fix is reverted.
7. **i18n.** Add `app.sidebarResizeHandle.ariaLabel` to en plus all 7 shipped locales
   (`catalogs.test.ts` fails otherwise), then regenerate `en-XA`.

### Tests

- `useLayout.test.ts`: clamp against the viewport and the open panel; merge-write keeps `panelW`;
  snap-collapse threshold; double-click reset; keyboard steps; re-clamp on resize.
- `shellContract.test.ts`: the sidebar handle exists, sits outside the drag region, and is hidden
  when collapsed.
- `cssContract.test.ts`: `html[data-resizing] .body` turns off the transition.
- **New Playwright spec** `layout/sidebarResize.spec.ts` against `dev:web` (9 tests). The empty shell renders
  without IPC, which was confirmed while writing this plan. It drags the handle and asserts the
  column width, reloads and asserts the width persisted, double-clicks and asserts 280, and runs
  under `en-XA` at 220px with no overflow.

---

## 4. Part 2: Settings from the top bar

### Recommendation

Put a **settings split-button in `MainHead`'s `head-actions`**, next to the theme and panel
toggles. That row is the top bar people actually see and reach for.

```
[≡] New chat ·····································  [☾] [▣³] [⚙▾]
```

- **Click ⚙:** open Settings on the **last section visited** this session (Providers on first
  open). One click, which fixes the "2–3 clicks" complaint.
- **Click ▾, or right-click ⚙:** a dropdown built on the existing `workspace/Menu.tsx`, which
  already gives focus management, arrow keys, and Escape:

```
Settings…                     Ctrl+,
─────────────
Providers & keys                  3
Chat defaults
Connectors                        2
Appearance
Privacy & data
─────────────
Export diagnostics
About
```

*As built:* the menu has no **Keyboard shortcuts** item, because that sheet does not exist until
PR 5, and a dead item is worse than no item. It also has no separate **Check for updates**:
updates live in the About section, so that row would duplicate About. Section labels are copied
from the settings nav in every locale and registered in G12 (`uiCrossReferences.test.ts`), so
the menu and the sheet cannot name a section differently.

**Why `MainHead` and not the 32px caption row.**

- `MainHead` already holds the other app-level toggles, so the controls stay in one cluster.
- It is not a drag region. The caption row is, and `shellContract.test.ts` pins its rules. Tauri
  hit-tests only the element under the cursor, so every non-button child we added there would
  also need `data-tauri-drag-region`.
- macOS draws the traffic lights over the caption row's left edge, and that placement is still
  unverified per the `.sb-head` CSS comment. Keeping new controls out of that strip avoids the
  risk.
- Moving controls into the caption row is still worth doing, but as part of a deliberate
  single-bar redesign (Part 3, P3-a), not as a one-button addition.

### Related changes, same PR

- **B1.** The chip menu's **Settings** item and `Ctrl+,` both call `openSettings()` with no section,
  which resolves to the last section visited (session memory in `App.tsx`, falling back to
  `providers`). The label, the hint, and the destination then agree.
- **B2.** When the sidebar is collapsed, `MainHead` gets **New chat** (+) and **Search** icons to
  the left of the title. `.sb-reveal` moves into `MainHead` as a normal flex child instead of
  `position: fixed`, the kind of overlay that `TitleBar.tsx`'s header comment says the V9 layout
  deliberately removed. With that, every sidebar action has a pointer path in both states.
  Update the `shellContract` "collapsed sidebar reveal affordance" test to follow it.
- **Palette coverage.** Add `>` commands for the sections that lack one: `chat`, `prompts`,
  `appearance`, `branding` (when enabled), and `privacy`. Extend `settingsCompleteness.test.ts`
  (guard G6) so that **every** `SettingsSection` needs a palette command, which keeps new sections
  from drifting.
- **Leave the sidebar chip alone**, so existing muscle memory keeps working. *As built:* the
  *Configure* heading is not renamed. Renaming it to *Settings* would put a "Settings" heading
  directly above a "Settings" item.
- **i18n.** Add `workspace.mainHead.settingsButton{AriaLabel,Title}`,
  `workspace.mainHead.settingsMenu.*`, `workspace.mainHead.newChat*`, and
  `workspace.mainHead.search*`. `uiCrossReferences.test.ts` (G12/G13) ties any prose naming
  "Settings" to its label, so check the onboarding and help strings that point at the workspace
  menu.

### Tests

- `MainHead.test.tsx`: the gear opens settings; the chevron opens the menu; arrow-key navigation;
  each item calls `onOpenSettings(section)`; New chat and Search render only when the sidebar is
  collapsed.
- `App.smoke.test.tsx`: opening from the gear, choosing Appearance, closing, then pressing `Ctrl+,`
  lands on Appearance.
- `Sidebar.test.tsx`: the Settings item no longer passes `'appearance'`.

---

## 5. Part 3: Other improvements, prioritised

### P1: dead ends and defects (do next)

**a. Overlay sidebar below 900px (B3).** Below the breakpoint, `Ctrl+\` and the head's ≡ button
open the sidebar as an **overlay drawer**: `position: fixed`, full height under the caption row,
280px wide, with a scrim, focus trapped via the existing `useFocusTrap`, and closed by Escape, a
scrim click, or selecting a chat. Track overlay state separately from `data-sidebar`
(`data-sidebar-overlay="open"`) so the saved desktop preference is untouched. This is the
follow-up the `workspace.css:644` comment already names. Do the same for the doc panel with
`Ctrl+J`.

*As built:*
- **Breakpoints.** `useColumnOverlay` handles the sidebar at ≤900px and the panel at ≤1100px.
  The panel had the same dead end between 900 and 1100px.
- **One overlay at a time.**
- **What opens the panel overlay.** Opening an artifact opens it; a document tool firing
  mid-stream does not, since it only sets the desktop preference, so nothing drops over a thread
  being read.
- **Grid placement.** The four grid columns are placed explicitly, because a `position: fixed`
  column would otherwise let auto-placement slide the thread into a 0px track.
- **Focus.** Focus moves into the overlay, falling back to the container when it has no controls
  (the empty artifact panel).
- **Tab order.** A collapsed or force-hidden column is now `visibility: hidden`. Before this, its
  zero-width content stayed in the Tab order.
- **`--panel-open-w`.** The panel moved to an `--panel-open-w` / `--panel-w` split like the
  sidebar's, which also fixes panel content reflowing during its collapse animation.

**b. Sidebar row actions (B6).**
- Add a **⋯ button** on hover and focus for each conversation row. It opens the same menu as
  right-click, and so do Shift+F10 and the ContextMenu key.
- Move the context menu onto `Menu.tsx` for arrow keys, focus on open, and focus return. Clamp its
  position to the viewport.
- Add **Rename** to the menu, and double-click a row title for inline rename. The palette's
  `renameChat` already does the IPC work.
- Move the hand-rolled workspace-chip menu (`Sidebar.tsx:150-217`) and the `StatusLine` popover
  onto `Menu.tsx` as well. That puts one keyboard model behind every menu.

### P2: quality and discoverability

**c. Keyboard shortcuts sheet (`Ctrl+/`).** Conduit has 9 global hotkeys and the only place they
show up is tooltips. Build a small sheet from a single registry exported by `useHotkeys.ts`, so
the sheet and the bindings cannot drift. It also appears in the settings menu and the palette.
This matches Claude Code desktop's `Ctrl+/`.

**d. Taskbar and window title (B7).** Set the window title to `"<chat title> — Conduit"` through
`getCurrentWindow().setTitle()` (Tauri) plus `document.title` (dev:web). Check whether
`core:window:allow-set-title` is already allowed in `src-tauri/capabilities` before adding it
(ADR-008 governs that surface).

**e. Artifact panel opens when needed.** New chats with no artifacts currently open a 420px empty
state, about 30% of a 1440px window.
- Default the panel to *closed* when the active chat has no artifacts, and open it automatically
  on the first promote.
- An explicit user toggle still wins and is saved.
- The existing `panel-toggle-badge` count keeps the panel discoverable.
- *This changes current behaviour, so it needs sign-off.*

**f. Grouped settings navigation.** The 12 sections sit in one flat list. Group them under small
headings: **Models** (Providers, Chat defaults, Web search), **Workspace** (Workspace, Connectors,
Prompts, Skills, Memory), and **App** (Appearance, Branding, Privacy & data, About). This is
navigation markup only, with no settings changes.

### P3: larger, design-first

**a. Unified title bar.** Merge the 32px caption row and the 46px `MainHead` into one ~44px bar:
- `[mac traffic-light inset] [≡] [chat title] ···drag space··· [☾] [▣] [⚙▾] [— ▢ ✕]`
- It saves about 34px of vertical space for every chat.
- It follows the Windows guidance: interactive controls allowed, empty space stays draggable,
  double-click maximises.
- It costs a V9 spec revision, a redo of the `shellContract` drag-region rules, and verification on
  a real Mac.
- Mock it first, then decide.

**b. Settings search.** Add a search field at the top of the settings nav. Build a static index
from each section's labels through their i18n keys, so it works in every locale. It filters the
nav, opens the section, and scrolls to and highlights the matching row.

**c. Density and text size.** Add `html[data-density="compact|comfortable"]` (row heights,
paddings) and a chat text-size step that is separate from app zoom. Both are renderer-only prefs
in `uiPrefs.ts`, next to palette and mermaid scale, and cheap given the token system.

---

## 6. Delivery: PR slices

| PR | Contents | Risk |
| --- | --- | --- |
| 1 | Part 1: generalised resize hook, sidebar resize, drag-lag fix (B4), shared breakpoints (B5), re-clamp on resize | Low |
| 2 | Part 2: settings split-button, last-visited section (B1), collapsed-state New chat/Search (B2), palette coverage plus the G6 guard | Low |
| 3 | P1-a: overlay sidebar and panel below 900px (B3) | Medium (focus trap, state split) |
| 4 | P1-b: row ⋯ menu, Rename, `Menu.tsx` consolidation, viewport clamp (B6) | Medium (touches three menus) |
| 5 | P2-c/d/f: shortcuts sheet, window title (B7), grouped settings nav | Low |
| 6 | P2-e: artifact panel opens on demand | Needs product sign-off |
| — | P3 a/b/c: unified title bar, settings search, density | Design first |

**Every PR runs:**
- `pnpm -C apps/desktop check`
- `pnpm -C apps/desktop test` (includes the catalog, shell, and CSS contract guards)
- `pnpm -C apps/desktop test:layout`
- The Husky pre-commit hook, never with `--no-verify`

It also gets a manual pass in `dev:web` driven through Chrome DevTools MCP at 1440×900, 1024×768,
and 860×800, and a real-window pass on Windows with the `run-conduit` screenshot driver. Commits
use conventional-commit prefixes (`feat(shell):`, `fix(layout):`). Every layout change needs a Mac
check, because the traffic-light inset cannot be exercised from the Windows dev machine.

## 7. Open questions

1. **Settings placement.** Is the `MainHead` split-button (recommended) acceptable, or do you want
   the unified title bar (P3-a) now?
2. **Gear click behaviour.** Open the last section directly (recommended), or always show the menu?
3. **Artifact panel default (P2-e).** Is it OK for new, empty chats to open with the panel closed?
4. **Sidebar bounds.** 220px min / 480px max / 280px default. Any preference?
