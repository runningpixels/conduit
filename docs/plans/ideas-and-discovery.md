# Plan: Ideas — sample prompts for new users, and discovery that keeps going

## Status

**Implemented — 2026-09-26** (branch `feat/onboarding-discovery`, stacked on
the artifact network access branch, PR #78). Phases 0–3 shipped together with
21 ideas; the open questions were decided as recommended (see
[Decisions](#decisions)). Not yet built: thumbnails, cost in currency, the
"save a chat's first message as a prompt" action, and everything under
[Later](#later).

## Why

A new user finishes onboarding and lands on "What are we working on?" and an
empty composer. Nothing says what Conduit is good at, and most of what it is
good at is invisible until used: HTML pages that are real tools, pages that
fetch live data, document collections, image generation, connectors, a
workspace folder. The live batteries (September 2026) kept producing things
people would not think to ask for — a Paris weather dashboard with a 7-day
forecast, a currency converter with live rates, a GitHub profile viewer, a
morning briefing pulling from four sites, a pomodoro timer, a playable Snake
game. Each worked from a one-line prompt. The gap is not capability, it is
knowing what to type.

And it is not only day one. Features ship every release; a user who set up an
OpenAI key in week one never learns that image generation arrived in week six,
or that the dashboard they made can now show live data.

## What others do (research, September 2026)

Full notes were gathered from product docs, release posts and NN/g; the useful
parts:

| Pattern | Who | Take-away for Conduit |
|---|---|---|
| Curated gallery by *intent*, with the generating prompt visible and a "remix" | Claude Artifacts "Inspiration" (All · Learn something · Life hacks · Play a game · Be creative · Touch grass), Lovable templates (Preview / Remix with a config step) | Categories by what the user wants, not by feature. Show the prompt. Let people start from it rather than copy it. |
| Community-ranked template grids | v0 (views/likes, Trending), Notion gallery ("most used this week") | Needs a backend and telemetry — not for us. Freshness must come another way. |
| Server-fed discovery feed | Perplexity Discover, Copilot Work Cards (being scaled back) | Same. |
| Opt-in hub of installable content | Msty Discover Hub (skills, prompts, knowledge stacks from registries), AnythingLLM Hub (remote bundles **off by default**), Raycast Store | For a local-first app, remote content is explicit and opt-in; a bundled offline set exists regardless. |
| Empty-state chips | Claude.ai, ChatGPT, Open WebUI (`DEFAULT_PROMPT_SUGGESTIONS`), Jan quickstart | Open WebUI's bug — an empty list still shows hard-coded English chips — is the failure to avoid: suggestions must be removable and localized. |
| Contextual activation, no gallery | ChatGPT canvas, Dia `/` skills | Surface a capability next to the action it fits. |
| On-device personalization, stated as such | Raycast ("computed on-device, never sent as telemetry") | The only clear precedent. A differentiator worth saying out loud. |
| Store wound down | ChatGPT GPT Store (custom GPTs retiring through 2026) | A big catalog of third-party "apps" is not the goal; a small set of things that work is. |

From UX research: NN/g (March 2026) calls the empty prompt box AI's "missing
UI" — state what the tool is for, offer **3–6** concrete starting points next
to free text. Nudges work when tied to an observed action and fail when
timed, repeated or hard to dismiss (NN/g alert fatigue; Smashing, July 2025).
Published numbers on starter-prompt lift are vendor marketing; we should not
plan around them.

Two things nobody does, both of which matter for bring-your-own-key:

1. **Only suggest what works here.** A sample that needs a key, an image model
   or a connector the user does not have fails on click and reads as broken.
2. **Say what it costs.** Every run spends the user's own API budget. No
   product labels this. A local model costs nothing, and we can say so.

## Where Conduit is today

(Code survey, 2026-09-26.)

- **Onboarding** (`onboarding/Onboarding.tsx`): appearance → provider → privacy
  → connectors → finish. Finish is a read-only review; no "try this".
- **Empty chat** (`ChatView.tsx` `threadEmpty`): the greeting "What are we
  working on?" and the composer. A V7 build had four prompt cards and four
  shortcut chips here; the V9 pass removed them on purpose
  (`styles/chat.css` — "the greeting is affordable precisely because nothing
  competes"). Anything we add back must respect that.
- **Follow-up chips** (`chat/suggestedPromptLogic.ts`): up to four under a
  reply — artifact edits, creation retries, informational or generic
  follow-ups. Clicking **fills** the composer; it never sends.
- **Prompts library** (Settings → Prompts, migration 0007): user prompts with
  `{{variables}}` and a fill dialog. Empty on install; reachable only from
  Settings.
- **Skills**: import only; none bundled.
- **No capability manifest.** Whether a model can make images, search the web
  or use tools is decided by scattered predicates (`modelGeneratesImages.ts`,
  `webSearchIntent.ts`, `agentTools.ts`, `isLocal`, `localOnly`).
- **No "what's new"** anywhere.
- Stale comment: `ArtifactEmptyState.tsx` says prompt chips live in the chat
  empty state; they do not.

## Design

### One catalog of ideas

An **idea** is a small, tested starting point: a title, one line saying what
you get, the prompt, and what it needs.

```ts
interface Idea {
  id: string;                    // stable: 'live-weather-dashboard'
  category: IdeaCategory;        // by intent, see below
  // i18n keys under ideas.<id>.{title,blurb,prompt}
  needs: Capability[];           // [] = works with any model, offline
  size: 'quick' | 'medium' | 'long';   // expected output, for the cost hint
  variables?: string[];          // {{city}} — filled before use
  preview?: string;              // bundled thumbnail (webp), optional
  addedIn: string;               // app version that shipped it → "New"
  verified: { model: string; on: string }; // last live battery pass
}
```

The catalog is bundled with the app (a TypeScript module plus i18n keys and
thumbnails). No network. It changes when the app updates — which is also when
new capabilities arrive, so the two stay in step.

**Categories by intent** (after Claude's gallery, adapted to what Conduit is
good at): *Make a tool* · *Live data* · *Learn something* · *Play* ·
*Write & plan* · *Your files* · *Images*.

**Seed set (~24)**, drawn from what the batteries proved:

| Idea | Category | Needs |
|---|---|---|
| Pomodoro timer | Make a tool | — |
| Budget tracker by category | Make a tool | — |
| Sortable table from pasted data | Make a tool | — |
| Currency converter with live rates | Live data | network |
| Weather dashboard for {{city}} | Live data | network |
| GitHub profile viewer | Live data | network |
| Morning briefing (weather, Hacker News, Wikipedia) | Live data | network |
| Explain bonds with an interactive diagram | Learn something | — |
| Interactive periodic table | Learn something | — |
| Flashcards for 10 {{language}} verbs | Learn something | — |
| Cheat sheet for {{topic}} | Learn something | — |
| Snake game | Play | — |
| Quiz on {{topic}} | Play | — |
| 5-slide pitch deck | Write & plan | — |
| One-pager / landing page for {{business}} | Write & plan | — |
| Compare three laptops as a page | Write & plan | web search (optional) |
| What happened this week in {{field}} | Write & plan | web search |
| Ask your documents | Your files | documents |
| Tidy the README in my folder | Your files | workspace |
| Logo for {{business}} | Images | image generation |
| Illustrate a children's story page | Images | image generation |
| … | | |

Every idea is **verified**: the live battery (the Playwright-over-CDP harness
used for artifact testing) runs each prompt against a cloud model and, for
ideas that need nothing, a local model, and records the pass in `verified`.
A unit test fails the build if an idea lacks its strings, names an unknown
capability, or — the "converter" lesson from the ADR-010 runs — has a
*Make a tool / Live data / Play* prompt that the document-intent router would
not give document tools to.

### One capability resolver

A single `useCapabilities()` answers, for the active provider and model:
`artifacts`, `network` (ADR-010 on and not local-only), `webSearch`,
`imageGen`, `documents` (a collection exists or can be made), `workspace`,
`connectors`, `localModel`. Each is **ready**, **needs setup** (with the
Settings section that fixes it), or **off here** (local-only or unsupported).
It wraps the existing predicates rather than duplicating them, and becomes
the one place new features declare themselves.

An idea is shown as:
- **ready** — all needs ready;
- **needs setup** — a need can be set up: the card says what ("Needs an image
  model") and its button opens that Settings section instead of running;
- **hidden** — a need is off here (e.g. live data in local-only mode). "Show
  all ideas" reveals them, greyed, with the reason.

### Surface 1 — the Ideas page (the dedicated tab)

A sidebar entry **Ideas** under Documents, also in the command palette.

- First line states what Conduit does (NN/g): "Things you can make and do
  here. Each one starts a chat with the prompt filled in — change it, then
  send."
- **New in this version** row when the app has ideas with `addedIn` newer
  than the version the user last visited the page on. This is the "what's
  new": every feature release ships with ideas that use it (ADR-010 ships the
  weather dashboard, converter, GitHub viewer, morning briefing).
- **For you** row: ready ideas from categories not tried yet (see
  [Personal, on this device](#personal-on-this-device)).
- Category tabs, then a card grid: thumbnail, title, one line, badges —
  *Uses the internet (asks per site)*, *Needs web search*, *Works offline*,
  and a size/cost hint: "Quick · free on your local model" / "Long build ·
  about 8k output tokens". Search box.
- **Try** opens a new chat with the prompt in the composer (variables filled
  first through the Prompts library's existing fill dialog, pre-filled with
  sensible defaults: "Paris"). It does not send: the user sees what will run
  and what it may cost, and can edit it. Consistent with follow-up chips.
- A **✓ Tried** mark after an idea's chat is sent. Tried ideas sink.
- Tab **My prompts**: the Prompts library, moved here from Settings (Settings
  keeps a link). Saved prompts and ideas are the same act — "start from
  something" — and the library is invisible where it lives now. Any chat's
  first message can be saved as a prompt from the message menu.

### Surface 2 — the empty chat, quietly

Under "What are we working on?", one line of **three** small text chips and
"More ideas →", not cards. Only ready ideas; a different three per new chat;
never the same idea twice in a row. After five chats started from the
composer without using a chip, the row stops appearing (the user knows what
they want); "Show ideas in new chats" in Settings brings it back, and a ✕ on
the row turns it off. This keeps V9's quiet empty state — one line, below the
greeting, dismissible — while ending the blank page.

### Surface 3 — onboarding's last step

Finish becomes "You're set up — try one": three ready ideas chosen for the
setup just made (local model → offline ideas; cloud key → one live-data
idea if network is on), plus "Explore more ideas". Picking one completes
onboarding and opens the chat with the prompt filled.

### Surface 4 — the right idea at the right moment

Tied to what the user just did, never to a timer, never a modal:

- **Capability follow-up chip.** `deriveSuggestedPrompts` may add *one* chip
  that points at a capability the reply did not use, when the reply fits:
  a table or numbers in prose → "Make this an interactive dashboard"; an HTML
  page with a hard-coded data sample and network ready → "Make it use live
  data"; a long explanation → "Turn this into flashcards". At most one per
  reply, only if ready, and a capability chip the user has ignored three
  times is not offered again.
- **New capability spotlight.** When a capability goes from off/needs-setup to
  ready — an image-capable key added, web search turned on, first document
  collection created, network access on after an update — the Ideas entry
  gets a dot and the page opens on "Now you can: 3 ideas that use image
  generation". Once seen, gone. No toast, no dialog.
- **Artifact panel empty state** gets one line: "Not sure what to make? See
  ideas" — and its stale comment is fixed.

### Personal, on this device

Stored locally (settings/DB, never sent): ideas tried, ideas dismissed, which
categories were started from, capability chips ignored, last Ideas-page
version seen. Ordering uses only these — unexplored ready categories first,
tried ideas last. Chat content is not analysed. The Ideas page says so in one
line: "Chosen on this device from what you've tried; nothing is sent." A
"Reset" in Settings clears it.

### Cost hint

`size` maps to an output-token range from the battery runs. With a local
model: "free on your computer". With a cloud model whose price is known to
the usage table (migration 0008): an approximate cost. Otherwise just
Quick / Medium / Long. Live-data ideas add "plus the requests it makes"
(which cost nothing on the key but reach the internet).

### Accessibility and localization

Cards and chips are native buttons in a list; arrow keys move within a row;
badges have text, not only icons; the grid reflows to one column. Idea
strings live in the normal catalogs under `ideas.*` (title, blurb, prompt ×
~24 ideas ≈ 75 keys × 7 locales, provenance, pseudo-locale). Prompts are
translated so a German user sends a German prompt; the battery runs a sample
in two locales.

## Phases

### Phase 0 — catalog, resolver, battery (2–3 days)
- `ideas/catalog.ts`, types, 12 ideas to start; `useCapabilities()` over the
  existing predicates; tests (strings, needs, router check).
- `scripts/ideas-battery` from the CDP harness: runs each idea, records
  pass/model/date, screenshots → thumbnails.

### Phase 1 — the Ideas page (3–4 days)
- Sidebar entry, palette command, page with categories, cards, badges,
  search, Try (with variables), Tried marks, needs-setup routing.
- i18n for page + first 12 ideas.

### Phase 2 — empty chat row and onboarding picks (1–2 days)
- The three-chip row with its stop rule and setting; onboarding's finish
  step.

### Phase 3 — moments (2–3 days)
- Capability follow-up chip; spotlight on capability change; "New in this
  version"; artifact empty-state line.
- My prompts tab (library moved from Settings); save first message as prompt.
- Remaining ~12 ideas.

### Later
- **More ideas without an app update:** a signed ideas bundle fetched with
  the update check (same consent, same signature verification, off in
  local-only), never a live feed.
- **Share an idea:** export an artifact with its prompt as an idea file a
  friend can import — remix without a community backend.
- Ideas that carry a skill or a connector suggestion ("needs the GitHub
  connector — add it").

## Decisions

Taken 2026-09-26, as recommended:

1. **Name:** "Ideas".
2. **Try fills the composer**; it never sends. The user sees what will run.
3. **Empty chat:** one line of three, which stops after five chats started
   without it and has an off switch (✕, or the Ideas page).
4. **My prompts** is a tab on the Ideas page; Settings → Prompts stays as
   well, so no existing path breaks.
5. **No live feed.** More ideas arrive with app updates; a signed bundle via
   the update check is the only later option considered.

## As built

- `src/ideas/catalog.ts` — 21 ideas, `IDEAS_REVISION`; `catalog.test.ts`
  fails the build when an idea lacks strings or a page prompt would not reach
  the document tools (and checks image, web search and workspace routing).
- `src/ideas/capabilities.ts` — `resolveCapabilities()` wraps the existing
  predicates: network (ADR-010 + local-only), web search, image generation
  (the image tool's provider gate), documents (a collection exists),
  workspace (tools + consent). ready / setup / off.
- `src/ideas/ideaState.ts` — tried, pending, starts-without-idea, row hidden,
  seen revision, spotlight, chip offers; localStorage only.
- `src/ideas/selectIdeas.ts` — starters (three categories, rotated per chat,
  no long builds on a local model), For you, onboarding picks, spotlight,
  new.
- `src/ideas/IdeasSheet.tsx` (sidebar **Ideas**, palette "Browse ideas"),
  `IdeaStarterRow.tsx` (empty chat), onboarding finish picks,
  `capabilityChips.ts` (liveData / dashboard / flashcards; one per reply,
  gives up after three ignored offers), and a "See ideas" link in the empty
  artifact panel.
- Cost hint is Quick / Medium / Long build, or "Free on your local model".

## Risks

- **Ideas that stop working** as models change. The battery and the
  `verified` stamp are the guard; a failing idea is fixed or pulled before
  release.
- **Clutter creeping back** into the empty state. The row is capped at one
  line, stops on its own, and has an off switch.
- **Suggestions that feel like ads.** Every suggestion is for something the
  user already has; nothing points outside the app.
- **Translation cost** of prompts; mitigated by starting with 12 ideas.
- **Cost surprises**: the hint is approximate; long builds say so up front.
