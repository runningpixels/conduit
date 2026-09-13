# Artifact panel — room to actually work in it

Status: **implemented** · Branch: `feat/wide-artifact-panel` (stacked on #48) · 2026-09-13

The right-hand panel is where artifacts are previewed, edited and exported: HTML pages,
reports, code. It is capped at **560px**. On a 1440px window with the sidebar open that is 39%
of the width, and an HTML artifact built for a normal page renders at roughly phone width.
Documents and code wrap well before they need to.

## 1. Today

| Constraint | Value | Where |
| --- | --- | --- |
| Min / default / max width | 280 / 420 / **560** px | `useLayout.ts` `PANEL_MIN/DEFAULT/MAX` |
| Thread floor while dragging | 420px | `THREAD_MIN` |
| Hidden at or below | 1100px (overlay since #44) | `PANEL_BREAKPOINT` |
| Presets / expand | none; double-click resets to 420 (#42) | |

The 560 cap was chosen when the sidebar was fixed and the thread had to be protected by
constant. Since #42 the thread floor is enforced dynamically, so the fixed cap no longer protects
anything. It only limits the panel.

## 2. What others do

- **Claude (web).** The artifact opens in a split pane beside the chat, and the pane can be
  resized. A full-width mode hides the chat for interactive artifacts, and you resize or dismiss
  to get back.
  ([AI UX Playground teardown](https://www.aiuxplayground.com/teardowns/claude/artifacts/),
  [Anthropic: artifacts](https://support.anthropic.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them))
- **ChatGPT Canvas.** The canvas takes most of the window and the chat narrows to a column beside
  it, which inverts the usual split: the work product is primary.
  ([BGR](https://www.bgr.com/tech/chatgpt-got-a-great-design-change-now-that-canvas-rolled-out-to-everyone/))
- **Width requests.** Both products draw steady requests for more width, and extensions exist
  just to widen them.
  ([OpenAI community](https://community.openai.com/t/allow-users-to-customize-chat-window-width-in-chatgpt/958512))

The common shape is: resizable, a way to give the artifact most of the window while the chat
stays usable, and a way to give it all of the window.

## 3. Directions to iterate (in the running app, via Chrome DevTools MCP)

1. **Lift the cap.** The max becomes whatever the thread floor allows. The floor drops to about
   360px, which is still enough for the composer.
2. **Width presets.** Show the three widths as explicit choices in the panel header, not only by
   dragging:
   - **Side:** today's width.
   - **Split:** the thread and panel share the space.
   - **Wide:** the thread at its floor.
3. **Focus.** The panel takes the whole body; sidebar and thread step aside. One control, one
   shortcut, and Escape to leave.
4. **Content-aware default.** An HTML artifact opens at Split, and text or code keeps today's width.

Each direction gets screenshots at 1440×900 and 1920×1080 against real artifact content
(an HTML dashboard, a Markdown report, a code file) and is judged on:
- whether the artifact renders at a usable width,
- whether the thread and composer stay usable,
- how discoverable the control is, and
- how many clicks it takes to get back.

**Enabler:** add a dev-only `?route=artifacts` seam, matching `?route=onboarding`, that seeds
sample artifacts. `dev:web` has no backend, so without it there is nothing to put in the panel,
for design iteration or for the layout suite.

## 4. Decisions

| # | Decision | Why (round) |
| --- | --- | --- |
| 1 | **No fixed ceiling.** `PANEL_MAX` stops binding; the thread floor does, lowered from 420 to 400px | The 560 cap clipped a 4-card dashboard at any window size (R0) |
| 2 | **Expand** (⤢ in the panel toolbar, `Ctrl+Shift+E`, palette, shortcuts sheet): the sidebar steps aside and the panel takes all but a 400px chat column. It is temporary: drags while expanded don't persist, and Restore brings back the exact layout. It ends on its own when the panel is hidden, the window turns narrow, or the sidebar is asked for | Dragging alone topped out at 719px on 1440 (R1). Canvas-style kept the chat usable at 1019px (R2b, R3) |
| 3 | **No separate "focus" (chat hidden) mode, for now** | It gave 1421px on 1440 (R2a) but strands the conversation, and Expand already fits the widest fixture. Revisit if real artifacts need it |
| 4 | **Documents read at a measure.** Markdown and plain-text previews centre at ~80ch with the surface filling the pane. Tables break out to the right, keeping the text's left edge. HTML stays full width | At 1499px, prose ran ~195 characters a line (R3). A measure alone wrapped every table cell (R4) |
| 5 | **The thread survives 400px.** The status line wraps between facts rather than inside them, and the greeting scales down via a container query on `.thread-inner` (not `.center`, whose layout containment would trap ChatView's dialog backdrops) | "claude-" / "sonnet-4" and "not" / "configured" stacked (R1) |
| 6 | **Tab names always show.** Tabs get a 96px floor with a thin scrollbar, and the toolbar spacer yields to the tab strip | Tab names measured 0px at every width: the spacer took half the free space (R0) |
| 7 | **`?route=artifacts`** dev seam with fixtures, including opening them locally | Nothing to iterate or measure against in dev:web otherwise |

## 5. Iteration log

All rounds ran in dev:web through Chrome DevTools MCP against `?route=artifacts`.

- **R0, baseline.** Panel 550px (1440 and 1920 alike). At 1920 the thread got 1069px of mostly
  empty space.
  - The dashboard's 4th card and table were clipped, with a horizontal scrollbar.
  - Tab names were 0px wide.
- **R1, cap lifted.** Panel 719px at 1440 with the sidebar open, and the dashboard fits.
  - The status line shattered at 420px.
  - The tab strip showed a heavy native scrollbar.
- **R2a, focus (prototype, injected CSS).** Panel 1421px. Excellent for the artifact, but no way
  back to the chat and a stray handle line at the left edge.
- **R2b, canvas (prototype).** Panel 1019px beside a 400px thread, and the chat stays usable.
  Chosen direction.
- **R3, Expand built.** Panel 1019px at 1440 and 1499px at 1920. The saved layout stays
  untouched, and the head-nav appears. At 1920, Markdown prose ran to ~195 characters a line.
- **R4, reading measure (prototype).** Prose reads well, but the table was squeezed into the
  column and every cell wrapped.
- **R4b, table breakout (prototype).** Rows are single-line (33px, matching the header). A 15px
  overflow into the padding showed a pane-wide scrollbar, fixed with `overflow-x: hidden` since
  nothing visible is clipped.
- **R5, converged, in the stylesheet.** Verified via `Ctrl+Shift+E`: panel 1019, prose 716px,
  table 731px, and the status line wraps between facts.

Pinned by `layout/artifactPanelWidth.spec.ts`. Its table assertion was mutation-checked: with the
breakout disabled, rows go to 53px against the 33px header and the spec fails.
