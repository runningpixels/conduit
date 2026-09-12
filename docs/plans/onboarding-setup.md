# Plan: First-run setup — language, appearance, and the trust settings

## Status

**Implemented.** All six phases landed, plus the Phase 0 fix. `tsc -b` is
clean, `pnpm test` is green at 1402 passed / 4 skipped (up from 1388; 16 new
tests, two rewritten), `pnpm i18n:check` and `i18n:status` are OK at 1087 keys
× 8 locales with zero missing, stale or orphaned, and the Playwright layout
suite passes 26/26.

Scope was `apps/desktop/src/onboarding/` plus the catalogs, styles and tests
that hang off it. **No Rust change and no `config-schema` change were
required** — every setting surfaced here already existed on `AppSettings` and
was already accepted by `update_settings`. The one exception is a pre-existing
first-run bug this plan had to fix to be coherent at all (see
[Phase 0](#phase-0--the-local_only-trap)), and that fix is also renderer-side.

### What shipped

| File | Change |
| --- | --- |
| `onboarding/Onboarding.tsx` | Five steps; finish became a review rather than a diagnostics checkbox |
| `onboarding/AppearanceStep.tsx` | New — language, theme, palette, text size |
| `onboarding/PrivacyStep.tsx` | New — local-only, keychain mode, update checks, diagnostics |
| `onboarding/persistSteps.ts` | New — the two write orders (see D2) |
| `settings/ProviderPicker.tsx` | Phase 0: clears `localOnly` for a cloud provider, and says so |
| `i18n/messages/*.json` | 14 new keys, 2 re-worded, 2 renamed — 8 locales, hand-translated |
| `styles/settings.css` | `.onboarding-summary`, `.onboarding-field` |

Three deviations from the plan as written, all deliberate:

1. **Diagnostics moved off the finish step** rather than being duplicated. It
   is a privacy decision, it reads as one beside the other three, and it left
   the finish step free to be a review. `onboarding.finish.diagnostics*` was
   renamed to `onboarding.privacy.diagnostics*`, carrying its seven existing
   translations across unchanged.
2. **The finish step became a review** — provider, model, language, theme,
   local-only — which the plan did not call for. Five steps of choices are more
   than anyone holds in their head, and local-only is worth showing back before
   the gate closes.
3. **Test navigation goes through the dot nav, not a run of Continues.**
   `goToFinishStep()` was two clicks and would have become four; it is now one
   jump that does not need re-counting the next time a step is added.

Companion reading:
[`docs/plans/localization.md`](./localization.md) (the `I18nProvider` remount
that dominates the design below, and the catalog gates that dominate the
effort), [`apps/desktop/src/onboarding/Onboarding.tsx`](../../apps/desktop/src/onboarding/Onboarding.tsx)
(what exists today),
[`docs/architecture/foundation-contracts.md`](../architecture/foundation-contracts.md)
(the credential boundary `ProviderPicker` already sits on).

---

## Why

Onboarding today is the BYOK gate and nothing else: pick a provider, paste a
key, optionally add connectors, acknowledge diagnostics, go. That was the right
first cut — chat is useless without a provider, and everything else is
genuinely optional.

It has since become the wrong shape for two reasons.

**The app ships in eight languages and asks in one.** A German user's first
screen is English prose explaining a trust model. The setting that fixes it is
four clicks deep in Settings → Appearance, behind chrome they cannot read. The
locale table exists, the catalogs exist, the picker exists — it is simply not
on the one screen where a non-English user is guaranteed to be.

**The defaults contradict the first thing onboarding asks for.** `local_only`
defaults to `true` and `active_provider` defaults to `anthropic`. Onboarding
walks the user through pasting an Anthropic key and then the first message
fails in Rust. This is covered in Phase 0; it is the strongest argument for
putting the trust settings in front of the user during setup rather than
leaving them to be discovered after something breaks.

---

## What exists today

`Onboarding.tsx` exports two components. `Onboarding` is a full-screen route —
not a modal — rendered from `App.tsx:1200` while `!onboardingCompleted ||
!hasProviderCredential`. `MigrationRecoveryNotice` takes priority over it
(`App.tsx:1188`) and is out of scope here.

Three steps (`provider → connectors → finish`), a clickable dot nav, and a hard
gate in `handleFinish` that re-probes the keychain before it will set
`onboardingCompleted`. It composes `ProviderPicker` and `ConnectorsSection`
from `workspace/settings/` rather than duplicating them, which is the pattern
this plan continues.

Every control this plan adds already exists in Settings:

| Control | Existing implementation | Stored where |
| --- | --- | --- |
| Language | `settings/AppearanceSection.tsx:52` | `AppSettings.language` (Rust) |
| Theme | `settings/AppearanceSection.tsx:97` | `AppSettings.theme` (Rust) |
| Palette | `settings/AppearanceSection.tsx:82` | localStorage, via `shell/uiPrefs.ts` |
| Text size / density | `settings/AppearanceSection.tsx:105`, `:119` | localStorage, via `workspace/readability.ts` |
| Update checks + channel | `settings/UpdatesSection.tsx:62`, `:73` | `AppSettings.updateChannel`, `.updateCheckEnabled` |
| Local-only | `settings/PrivacyDataSection.tsx:97` | `AppSettings.localOnly` |
| Keychain mode | `settings/PrivacyDataSection.tsx:128` | `AppSettings.keychainMode` |

The split in the "stored where" column is load-bearing and is the reason two
different persistence paths appear below. Rust-backed settings go through
`update_settings`; the renderer-only presentation prefs are localStorage and an
attribute on `<html>`, deliberately outside `AppSettings` so
`CANONICAL_SCHEMA_VERSION` does not move for a font-size preference
(`shell/uiPrefs.ts` module comment).

---

## The constraint that shapes everything: the locale remount

`I18nProvider` carries `key={applied.locale}` on its `RawIntlProvider`
(`i18n/index.tsx:447`). This is deliberate — switching language must re-mount
the subtree so nothing is left holding formatted text frozen in a `useState` or
a `useMemo`. The consequence is that **a language change re-mounts the whole of
`<App>`**, and therefore:

1. `App`'s `settings` resets to the `defaultSettings` placeholder and
   `settingsLoaded` goes false while the boot IPC re-runs.
2. `Onboarding`'s `step` resets to the first step.
3. Anything typed-but-unsaved — most importantly an API key mid-entry in
   `ProviderPicker` — is gone.
4. `App.tsx:994` then calls `setPreference(settings.language)` with the value it
   just re-read from Rust.

Point 4 is the trap. If the language change was optimistic local state only,
Rust still holds `'system'`, so the reconcile effect announces `'system'`, which
resolves to a *different* locale than the explicit choice did, which changes the
key, which re-mounts again. Best case the user's choice is silently reverted;
worst case it is an unbounded re-mount loop paced by the boot IPC. The long
comment at `App.tsx:972-990` documents exactly this hazard from the Settings
picker, and `App.smoke.test.tsx` counts boots to guard it.

Two design rules fall out, and they are the only genuinely delicate part of this
work:

- **Language is persisted with an awaited `update_settings` before local state
  changes.** Not through `useAutoSave` — its 250 ms debounce loses the race
  against the remount, and the write would land after the reconcile has already
  reverted the locale.
- **Language lives on step 1.** A remount that costs the user their step
  position and their half-typed key is unacceptable on step 3 and free on step
  1. Everything else in this plan — theme, palette, text size, update checks,
  local-only, keychain mode — causes no remount and can take the ordinary
  optimistic path.

A rejected alternative, for the record: persisting the step index to
localStorage so it survives the remount, which would allow the appearance step
to sit anywhere. It restores the step but not the unsaved key field, so it
solves the cosmetic half of the problem and leaves the one that loses user
input. Putting language first is strictly better and is less code.

---

## Phases

### Phase 0 — the `local_only` trap

Independent of this feature and currently broken on every fresh install.

- `crates/provider-core/src/schema.rs:1846` — `local_only: true` by default.
- `crates/provider-core/src/schema.rs:1844` — `active_provider: "anthropic"` by default.
- `apps/desktop/src-tauri/src/stream_manager.rs:499` — every non-local adapter is
  blocked while `local_only` is on.
- Nothing in the renderer ever clears it except the Privacy & data checkbox.

So the documented happy path — install, pick Anthropic, paste a key, say hello —
fails with `Cloud provider 'anthropic' is disabled while local_only mode is on`,
and the setting that caused it is on a settings pane the user has never opened.

**Fix:** clear `localOnly` when the user selects a provider whose descriptor
reports `isLocal: false`. `ProviderDescriptor.isLocal` is already on the
descriptor `ProviderPicker` renders from, so this is a few lines at the point of
selection. Do it in the new privacy step's line of sight — the user should see
the toggle in the state their provider choice implies rather than have it
changed behind them.

This lands first because the rest of the plan puts a `local_only` checkbox in
front of a user who has just chosen a cloud provider, and a checkbox that
contradicts the choice made two steps earlier is worse than no checkbox.

### Phase 1 — the step model

Extend `OnboardingStep` and the `STEPS` table in `Onboarding.tsx`:

```
appearance → provider → privacy → connectors → finish
```

Five is the practical ceiling for the existing `.onboarding-steps` dot row. The
fallback, if five reads as long in the built app, is to fold *privacy* into
*finish* — that step already carries the diagnostics checkbox, which is the
same trust conversation, and the merged step stays coherent.

Nothing else in the component's machinery changes: `goNext`/`goBack` key off
`stepIndex`, the dot nav maps over `STEPS`, and the finish gate is untouched.

### Phase 2 — `AppearanceStep`

New component in `onboarding/`. Renders **Language, Theme, Palette, Text size**.

Density and diagram scale are deliberately omitted — they are refinements, not
first-run decisions, and they are one click away in Settings once the app is
readable and the right colour.

- **Language** — `select` over
  `SHIPPED_LOCALES.filter(l => TRANSLATED_LOCALE_CODES.includes(l.code))`, the
  same filter as `AppearanceSection.tsx:64`. That filter is what keeps a locale
  with no catalog on disk out of the menu: offering 日本語, accepting the click
  and then rendering English is not a fallback a user can interpret. `onChange`
  must `await updateSettings({ language })` and only then call
  `onSettingsChange(persisted)`, per the rule above. Hold a busy state across
  the await; the remount tears the component down anyway.
- **Theme** — ordinary optimistic path through `onSettingsChange` +
  `useAutoSave`. `App.tsx:966` applies it live.
- **Palette / text size** — call `writePalette` and `applyUiReadability`
  directly, exactly as `AppearanceSection` does. localStorage-only, immediate,
  no IPC, no remount.

Live preview is free on this route: `Onboarding` renders inside `App`, so the
theme, palette and brand effects at `App.tsx:966-1007` already run. The user
sees the choice land on the screen they are standing on.

### Phase 3 — `PrivacyStep`

New component in `onboarding/` (or merged into the finish step, per Phase 1).
Renders **local-only**, **keychain mode**, **update checks + channel**, and the
**diagnostics** checkbox that already lives on the finish step.

Copy carries more weight here than controls. `PrivacyDataSection.tsx:117` is the
model to follow: state the trade rather than presenting two equal options — the
file-backed credential store is an escape hatch for machines with no usable
keychain, and it is weaker. The same applies to update checks, which are the
only network call the app makes besides the provider, and to local-only, whose
interaction with the provider choice Phase 0 just resolved.

Reuse the existing `settings.privacy.keychainMode.*` and `settings.updates.*`
message keys wherever the wording fits. This is not only about effort: guard
**G12** (`i18n/uiCrossReferences.test.ts`) enforces that prose naming a UI
element names it the way that element is labelled, and every new string is new
surface for that guard to police across eight languages.

### Phase 4 — the catalogs

The largest mechanical cost, and the part most likely to be underestimated.
Three gates apply:

- **G10** (`i18n/untranslatedLiterals.test.ts`) — a TypeScript-AST scan, not a
  regex. No renderer file may hold a user-facing literal. Every string goes
  through `t()`, with `// i18n-exempt: <reason>` reserved for developer-facing
  text.
- **`catalogs.test.ts:243`, "is complete, once it has shipped"** — `de`, `es`,
  `fr`, `ja`, `pt-BR`, `ko` and `zh-CN` must each carry every English key. **An
  English-only key fails the build on the commit that adds it.** Budget roughly
  25–35 new keys across seven locales.
- **Key shape** (`catalogs.test.ts:174`) — dot-namespaced, first segment from
  the known feature-area list. `onboarding` is already on it, so
  `onboarding.appearance.language.label` and friends are fine.

Then stamp provenance and regenerate the pseudo-locale:

```
node scripts/i18n-status.mjs --accept=de     # …and es, fr, ja, pt-BR, ko, zh-CN
pnpm i18n:pseudo                             # regenerates messages/en-XA.json
pnpm i18n:check                              # source ↔ en.json, both directions
```

`en-XA` is worth actually launching into once the step exists
(`?locale=en-XA`): a five-step dot row and a four-field appearance grid are
exactly the layout that a 40 %-padded catalog breaks first.

### Phase 5 — styles

`styles/settings.css:239-255` holds `.onboarding-shell`, `.onboarding-card` and
`.onboarding-steps`. Two things need checking rather than assuming: the card's
width against the appearance grid, and the dot row at five steps in the
narrowest supported window. `styles/cssContract.test.ts` and the Playwright
layout suite are the guards.

### Phase 6 — tests

`Onboarding.test.tsx` needs no new IPC mocks — its `vi.mock('../ipc/client')`
block already covers `updateSettings` and everything `ProviderPicker` and
`ConnectorsSection` reach for, and `baseSettings` is already a complete
`AppSettings` literal. Add:

- the appearance step renders its four controls;
- a theme change calls `onSettingsChange`;
- **a language change awaits `updateSettings` before `onSettingsChange`** — this
  is the regression test that protects against the silent revert, and it is the
  one assertion in this plan that must not be dropped for time;
- `localOnly` clears when a cloud provider is selected (Phase 0).

`Onboarding.i18n.test.tsx` is the German render of the same components. New
assertions about *language* go there, not in the English file — the split is
deliberate and explained at the top of that file.

`App.smoke.test.tsx` counts boots; re-run it, it is the remount-loop guard.

### Verification

```
pnpm -C apps/desktop check        # tsc -b
pnpm -C apps/desktop test         # vitest, including every i18n guard
pnpm i18n:check
pnpm -C apps/desktop test:layout  # playwright
```

---

## Effort and risk

| Piece | Size | Risk |
| --- | --- | --- |
| Step model + two new components | ~250 lines | Low — composition of controls that already exist |
| `local_only` fix (Phase 0) | ~10 lines | Low, high value |
| Catalogs: ~30 keys × 8 locales + provenance | bulk of the wall-clock | Low risk, high tedium |
| CSS at five steps | small | Medium — the layout contracts are strict |
| Language remount handling | ~20 lines | **Highest** — get the awaited persist wrong and the setting silently reverts |

---

## Decisions

**D1 — Language is step 1, not a persisted step index.** Driven entirely by the
`key={locale}` remount. Persisting the step index restores the step but not the
unsaved API key field; ordering solves both. Reversible only if the remount ever
stops happening, which `localization.md` argues it should not.

**D2 — Language persists synchronously, everything else optimistically.**
Language is the one setting whose own side effect destroys the component that
set it. The asymmetry is worth a comment at the call site, because it otherwise
reads as an inconsistency.

**D3 — Five steps, privacy separate from finish.** Reversible. If five dots read
as long in the built app, merge privacy into finish; the two are the same
conversation and the merged copy stays coherent.

**D4 — Density and diagram scale are omitted.** First run should ask what a user
can answer before they have seen the app. "Comfortable or compact line spacing"
is not that question; "can you read this" and "is it the right colour" are.

**D5 — No re-runnable setup entry point in this change.** A route back into the
gate has to not trap the user, which is the failure
`MigrationRecoveryNotice`'s three exits were written to fix. Worth doing, worth
doing separately.

**D6 — No shared component extracted between Settings and onboarding.** The two
surfaces want different copy and different density for the same underlying
fields, and `AppearanceSection` has tests pinned to its current shape.
Duplicating four `select` elements is cheaper than a refactor that has to keep
both callers happy. Revisit if a third surface ever wants them.
