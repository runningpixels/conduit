# Plan: Localizing Conduit

## Status

Draft, ready for implementation. Every open question raised during the audit is
resolved in [Decisions](#decisions) with a recommended answer — none are left
for later. Where a decision is reversible, that is stated.

Scope: the Conduit desktop app (`apps/desktop`, `crates/*`, `packages/*`) into
the seven languages the marketing site now ships, plus English.

Companion reading: [`docs/branding/README.md`](../branding/README.md) (the
`appName()` seam this plan leans on heavily),
[`docs/architecture/foundation-contracts.md`](../architecture/foundation-contracts.md)
(the trust boundary the IPC error work crosses).

## Summary

The website was localized by duplicating whole HTML pages. That approach is
correct for four static marketing pages and **fatal** for an app that ships
features weekly: there is no string catalog and therefore no mechanism to
detect that English changed. The seven translated copies of the site are
already free to drift, silently, and nothing reports it.

Conduit needs the opposite shape: one English catalog as source of truth, six
sibling catalogs generated from it, and CI that fails when they diverge. This
plan builds that, extracts roughly 300 renderer strings and a triaged subset of
the Rust error surface into it, and ships in three waves matching the website's
own rollout.

Estimated **7–8 engineer-weeks** to the first shipped locales (de, es, fr), with
waves 2 and 3 following at roughly one week each.

---

## Current state

Findings from a full read of the three repositories. Counts are floors — the
search patterns miss text split across JSX expressions and multi-line bodies.

### There is no i18n infrastructure of any kind

No `react-i18next`, no `formatjs`, no `lingui`, no catalogs, no locale switcher.
`apps/desktop/package.json` and `packages/ui/package.json` carry no i18n
dependency. `AppSettings` (`crates/provider-core/src/schema.rs:1585`, mirrored
to `packages/config-schema/src/generated/app_settings.ts`) has roughly twenty
fields and none of them is a locale.

The only `locale` references in the renderer are four `.localeCompare()` calls
used for sorting (`chat/ComposerModelPicker.tsx:214`,
`lib/conversationOrganization.ts:100`,
`workspace/settings/ProviderPicker.tsx:133`, and a comment in
`ipc/contracts.ts:64`). Date and number formatting already calls
`toLocaleDateString()` / `toLocaleString()` with an `undefined` locale, so it
silently follows the OS through the webview and cannot be overridden.

### String inventory

| Surface | Count | Notes |
| --- | ---: | --- |
| Renderer JSX text nodes | 169 | Densest in `workspace/settings/` (15 files), then `chat/` |
| Renderer JSX attributes | 127 | `aria-label`, `placeholder`, `title`, `alt` |
| Rust `Err` literals | 137 | Returned to the UI verbatim as `Result<T, String>` |
| Hand-rolled plurals | 6+ | English-only `n === 1 ? '' : 's'` |
| Locale-blind formatters | 4 | `timeAgo`, `dayGroup`, `formatSize`, usage counters |
| Non-webview strings | ~10 | OAuth page, native dialog titles, pre-webview failures |
| Truncating CSS sites | 59 | Plus 103 fixed-pixel width declarations |
| Text-based test assertions | 376 | Across 92 vitest files |

`packages/ui` is effectively copy-free — tokens, `primitives.tsx`, and bundled
fonts, with all text passed in as props. It needs no translation layer.

### What already helps

White-labelling forced product identity behind a seam: `appName()` in
`apps/desktop/src/brand/index.ts` and `brand::app_name()` in
`apps/desktop/src-tauri/src/brand.rs`, enforced by **Guard G9**
(`apps/desktop/src/brand/brandLiterals.test.ts`), a vitest test that scans
source as text and fails on a bare `'Conduit'` literal. The repo has six guards
in this family (G3, G4, G6, G7, G8, G9). An i18n guard is the same shape and the
team already accepts the pattern; this plan adds **G10**.

Settings deserialize with serde defaults and there is no migration runner, so
adding a `language` field to `AppSettings` is safe against existing
`settings.json` files on disk.

`ci.yml:85–93` already fails the build when the generated `config-schema`
bindings drift from Rust. That job is the natural home for the catalog checks.

### What the website established

`pixel-website/i18n/locales.json` defines eight locales — `en` plus `de`, `es`,
`fr`, `ja`, `ko`, `pt-BR`, `zh-CN` — all `dir: "ltr"`. Each non-English locale
is a full copy of five pages under `public/<code>/`.
`scripts/scaffold-locale.py` does the structural rewrite and stops there by
design; translation is a separate manual pass.

Three conventions are worth inheriting:

- **Product and provider names stay English.** German body copy reads
  "API-Schlüssel für Claude, GPT, Gemini, Ollama" — convention by example, never
  written down. This plan writes it down.
- **A locale fallback chain** already exists in `public/js/site.js:126–131`:
  exact match, then lowercased, then primary subtag, then `en`.
- **Word order is a real problem, already hit.** `SITE.ui` carries
  `downloadForSuffix` for ja/ko/zh-CN because those languages will not accept
  an English-style prefix. ICU placeholders solve this class of problem
  generically; the app should not reinvent the prefix/suffix hack.

One thing not to inherit: the site's CI (`deploy.yml`) checks only that
generated `.md` twins match their HTML. Nothing checks translated copy.

---

## Decisions

### D1 — Locale set: match the website exactly

`en`, `de`, `es`, `fr`, `ja`, `ko`, `pt-BR`, `zh-CN`.

Build the infrastructure for all seven non-English locales at once and ship them
in the website's own waves: **de, es, fr** first, then **ja, pt-BR**, then **ko,
zh-CN**. The marginal cost of a locale after the first is a catalog file and a
review pass; the expensive part is the infrastructure, and it is the same for
one locale as for seven.

Shipping in waves rather than all at once keeps the first review cycle small
enough to learn from.

### D2 — Runtime: `react-intl` (FormatJS)

Add `react-intl` to `apps/desktop`. It earns its dependency three times:

- `Intl.PluralRules` under the hood covers every plural rule in our seven
  locales for free. Hand-rolling this is the single most common way app i18n
  goes wrong, and we already have six hand-rolled English-only plurals.
- It supplies `FormattedNumber`, `FormattedDate`, and `FormattedRelativeTime`,
  which we need regardless to fix `timeAgo()` and `dayGroup.ts`.
- ICU MessageFormat in flat JSON is the easiest possible input for
  LLM-drafted translation and for a human reviewer reading a diff.

Alternatives considered and rejected: **i18next** (heavier, and its plural
handling predates `Intl.PluralRules`); **Lingui** (excellent, but its
compile-time macro means adding a Babel or SWC step to a clean Vite setup);
**hand-rolled** (plurals and date formatting are exactly the parts you must not
hand-roll).

Bundle cost is roughly 40 KB gzipped. For a desktop app that already bundles
Mermaid and KaTeX, this is not a consideration.

### D3 — Message IDs: explicit and hierarchical, not generated

IDs are dot-namespaced and written by hand:

```
settings.privacy.deleteData.title
chat.composer.sendLabel
onboarding.provider.stepTitle
error.validation.temperatureRange
consent.permission.sideEffectful
```

Not content-hash IDs. Hashes are stable under refactor but unreadable in a
catalog, and both an LLM translator and a human reviewer do materially better
work when the key tells them where the string appears and how much room it has.
Greppability matters more here than automatic dedup.

The first segment is the feature area and mirrors the source tree: `chat`,
`settings`, `onboarding`, `shell`, `workspace`, `artifacts`, `error`, `consent`,
`common`.

### D4 — Catalog layout

```
apps/desktop/src/i18n/
  index.ts              # provider, locale resolution, useT helpers
  locales.ts            # the locale table (mirrors website locales.json)
  messages/
    en.json             # generated by `formatjs extract` — source of truth
    de.json es.json fr.json ja.json ko.json pt-BR.json zh-CN.json
  provenance.json       # per-locale record of which English text was translated
  glossary.md           # shared terminology, see D7
  do-not-translate.txt  # literal terms that must survive translation
```

Flat `key -> ICU string` JSON. English is generated, never hand-edited. The
other seven are translated artifacts.

Catalogs are loaded with a dynamic `import()` keyed on the active locale, so
Vite code-splits them and only the active locale is parsed at startup.

### D5 — Missing keys fall back to English, never to the key

Configure `IntlProvider`'s `onError` so a missing or malformed message logs in
development and renders the English string in production. A user must never see
`settings.privacy.deleteData.title` in the interface. This is what makes wave-based
shipping safe: a partially translated locale degrades to English, not to
debugging output.

### D6 — Translation drift is detected by hash, not by hope

This is the one place the plan deliberately does more than the website does.

`provenance.json` records, per locale per key, the SHA-1 of the **English
string that was translated**:

```json
{ "de": { "chat.composer.sendLabel": "b3f1a2c…" } }
```

A script, `pnpm i18n:status`, compares each entry against the current English
value and classifies every key as `missing`, `stale` (English changed since
translation), or `current`. CI fails on `missing` for any shipped locale and
reports `stale` counts without failing. The translation step updates the hash
when a translation is accepted.

Without this, the app inherits precisely the failure mode the website has today.

### D7 — Terminology is governed by a shared glossary

`apps/desktop/src/i18n/glossary.md` defines the agreed translation of each
product concept, and `do-not-translate.txt` lists what must survive verbatim.

Do not translate: the product name (always via `{appName}` — see D8), `Claude`,
`Anthropic`, `OpenAI`, `GPT`, `Gemini`, `Ollama`, `LM Studio`, `OpenRouter`,
`Groq`, `DeepSeek`, `Mistral`, `OpenCode Zen`, `MCP`, `API`, `JSON`,
`Markdown`, `HTML`, `SQLite`, `AGPL`.

Translate consistently, decided once per locale: *artifact*, *connector*,
*skill*, *workspace*, *memory*, *conversation*, *provider*, *model*, *token*,
*context window*, *tool call*, *consent*, *thought*.

The website should adopt the same glossary. Nothing enforces that today, and two
surfaces using different German words for "connector" is a worse outcome than
either choice individually.

### D8 — Every product mention is a placeholder

Messages use `{appName}`, never a literal. A translated string with `Conduit`
baked in would break white-labelling in exactly the way Guard G9 exists to
prevent — and would do it in six languages at once, where nobody would notice.

G10 (D14) extends the G9 scan to catalog files.

### D9 — Rust returns error codes; the renderer translates them

Do **not** stand up a second catalog system (`fluent`, `rust-i18n`) with its own
locale plumbing, resource loading, and drift problem. Instead introduce a
structured error type and translate on the renderer side against the catalog
that already exists.

```rust
pub struct AppError {
    pub code: &'static str,              // "error.validation.temperatureRange"
    pub params: BTreeMap<String, String>,
    pub fallback: String,                // English, always populated
}
```

Serialized to `{ code, params, fallback }`. The renderer looks up `code`,
formats it with `params`, and renders `fallback` if the key is unknown.

The migration is incremental because of one impl:

```rust
impl From<String> for AppError {
    fn from(s: String) -> Self {
        AppError { code: "error.unknown", params: BTreeMap::new(), fallback: s }
    }
}
```

With that in place, all 137 existing `Err("…".to_string())` sites keep
compiling and keep behaving exactly as they do now. Commands are converted from
`Result<T, String>` to `Result<T, AppError>` file by file, and only the triaged
subset (D10) gets a real code.

This also closes a real defect the audit surfaced:
`commands/settings.rs:398` does `format!("Failed to back up database: {e}")`,
splicing raw OS error text into user-facing copy. Codes force that seam to be
explicit — the OS detail becomes a param, and the sentence around it becomes
translatable.

### D10 — Triage the Rust surface; do not convert all 137

Many of the 137 are internal invariants — `"consent meta lock poisoned"`
(`connector_runtime/consent.rs:177`) means a bug, not a user situation, and
translating it helps nobody. Convert the set users actually hit:

1. **`validation.rs:17–38,160`** — settings form validation
   (`"temperature must be between 0 and 2"` and siblings). Rendered directly
   under Settings inputs; the highest-traffic user-facing Rust text in the app.
2. **`crates/mcp-runtime/src/consent.rs:40–56`** — the three `PermissionLevel`
   descriptions shown in every connector consent dialog. Three strings, high
   traffic, safety-relevant. Convert these first as the pilot.
3. **`credentials.rs:188,227`** and **`encryption.rs:73–79`** — keychain and
   credential-store failures, hit at first run and after OS keychain changes.
4. **`stream_manager.rs:1529,1533,1539,1540`** — tool-call status lines rendered
   in the chat transcript, plus the `"Question"` fallback title at `:1277`.
5. **`commands/chat.rs:386–393`** — workspace root validation.
6. **`db/mod.rs:34–50`** — `DbError` display strings that reach the recovery UI.

Everything else keeps `error.unknown` with an English fallback. That is an
honest resting state, and it is where the value stops.

### D11 — Model-facing text stays English

The guardrail instructions at `stream_manager.rs:209,211,303,305` ("Only one new
document per round…") and the preambles at `skills.rs:29,33`
(`AGENTS_MD_PREAMBLE`) are addressed to the model, not the user. They are not
translated. Model instruction-following is more reliable in English, and these
strings are never rendered.

Only the four genuinely user-visible strings in `stream_manager.rs` (D10, item 4)
are extracted.

### D12 — One `language` setting drives the UI; the model follows it

Users will expect switching the interface to German to make replies German.
Splitting this into two settings is technically cleaner and will read as broken.

- `AppSettings.language` — `"system"` (default) or a locale code.
- The UI renders in the resolved locale.
- The system prompt gains one line: *"Reply in {languageName} unless the user
  writes in a different language."* The trailing clause matters — a user typing
  English into a German UI should get English back.
- Guardrail and skill preambles stay English (D11).

A per-conversation override is a reasonable later addition and is explicitly out
of scope for this plan.

### D13 — Locale resolution happens in the renderer; Rust is told, not asked

No `sys-locale` crate. The webview's `navigator.language` already follows the OS
on all three platforms.

Resolution order, mirroring `site.js:126–131`: stored `language` if not
`"system"` → `navigator.language` exact match → lowercased → primary subtag →
`en`.

Rust needs a locale only for the handful of strings it owns (D15), and it is
given one rather than detecting it:

- **OAuth callback page** — the renderer already initiates the flow, so it
  passes the resolved locale as a command argument.
- **Pre-webview migration failure** — read `language` directly from
  `settings.json`; if it is `"system"`, use English. This text appears when the
  database failed to migrate, on a small number of machines, once. English is an
  acceptable answer there and does not justify a locale-detection dependency.

`AppState::load` (`state.rs:72–82`) already reads settings before any window
exists, and `main.rs:32–33` resolves the brand at the same point, so there is a
precedent and a place to put this.

### D14 — Guard G10 and two catalog gates

Following the existing guard family:

- **G10** — a vitest text scan over `apps/desktop/src` failing on user-facing
  string literals in JSX text nodes and in `aria-label` / `placeholder` /
  `title` / `alt` attributes, and on a literal product name inside
  `messages/*.json`. Allowlisted: test files, `src/i18n/`, developer-only
  strings behind an explicit `// i18n-exempt` comment with a reason.
- **Key parity** — every shipped locale has every key in `en.json`.
- **ICU validity** — every message in every catalog parses, and placeholder
  sets match English exactly. A translator dropping `{count}` should fail CI,
  not render `{count}` to a user.

All three run in `ci.yml`'s existing `verify` job, next to the schema-freshness
check.

### D15 — Non-webview surfaces get a six-string Rust table

Three surfaces cannot reach the React catalog:

- `mcp_oauth.rs:237–256` — a hand-built HTML page served by the local OAuth
  callback listener and rendered in the user's **system browser**. Two strings.
- `db/migrations.rs:356–364,370–374` — migration failure text and the failure
  marker file, formatted before the webview exists. Two strings.
- Native file dialogs — `commands/branding.rs:451,492,525,550`,
  `commands/skills.rs:182,199`, `commands/chat.rs:531`.

The dialogs need **no** Rust catalog: the renderer already invokes those
commands, so the localized title and filter name are passed down as arguments.
That leaves roughly four to six strings in a small `src-tauri/src/i18n.rs`
table. The duplication is real, bounded, and documented in that file's header.

### D16 — Formatting follows the UI locale, not the OS

Replace `undefined` locale arguments with the active UI locale everywhere. A
user who chose German gets German month names and German number grouping,
regardless of OS region.

Applies to `lib/dayGroup.ts:23,55`, `artifacts/format.ts:45`,
`shell/Sidebar.tsx:81`, `chat/ChatView.tsx:454`, `chat/UsageSummary.tsx:13–18`,
`shell/StatusLine.tsx:108–112`, `workspace/settings/UsageSection.tsx:14`.

Collation likewise: a memoized `Intl.Collator(activeLocale, { sensitivity:
'base' })` replaces bare `.localeCompare()` at `ComposerModelPicker.tsx:214` and
`ProviderPicker.tsx:133`. `conversationOrganization.ts:100` already passes
`{ sensitivity: 'base' }` and only needs the locale added.

### D17 — CJK uses system fonts, not bundled ones

The website bundles Noto Sans JP, KR, and SC — 4.7 MB of woff2 — gated by
`unicode-range` in `public/css/cjk.css`. On the web that is necessary: you
cannot assume a visitor has a CJK face.

A desktop app can. Windows ships Yu Gothic, Malgun Gothic, and Microsoft YaHei;
macOS ships Hiragino Sans, Apple SD Gothic Neo, and PingFang SC; Linux desktops
ship Noto CJK through the distribution. Extend the stack in
`packages/ui/src/tokens.css` rather than adding 4.7 MB to every installer on
every platform for every user:

```css
--font-sans: "Geist", "Hiragino Sans", "Yu Gothic UI", "Malgun Gothic",
             "Apple SD Gothic Neo", "PingFang SC", "Microsoft YaHei UI",
             "Noto Sans CJK JP", system-ui, sans-serif;
```

The app's bundled faces (Geist, Geist Mono, Source Serif 4) have no CJK
coverage, so something must change either way. **Guard G8** ("the fonts stay
bundled") needs its comment updated to say that system fallbacks are permitted
for scripts we do not bundle — the guard's intent is that Latin text never
depends on a network fetch, and that intent is unchanged.

Reversible: if rendering proves inconsistent across platforms during wave 2 QA,
bundle the Noto faces and gate them by `unicode-range` exactly as the site does.

> **Unrelated finding, worth acting on:** the website's Korean font files are
> ~156 KB against ~1.1 MB for Japanese and Simplified Chinese. That gap is too
> large to be a subsetting artifact and looks like a single Fontsource slice
> rather than full Hangul coverage. Verify `/ko/` renders completely.

### D18 — Tests render under `en` with real catalogs

The 376 text-based assertions across 92 files are **not** 376 edits. If
extraction preserves English message values byte-for-byte, and tests render
inside an `IntlProvider` bound to the real `en.json`, then
`screen.getByText('Save')` keeps passing untouched.

Only assertions on strings we deliberately restructure need rewriting — the six
plurals and the constructed sentence at `agentTools.ts:686`. Budget tens of
edits.

A `renderWithIntl()` helper in `src/test/` wraps the existing render calls. The
setup file `src/test/setup.ts` gains the provider default.

### D19 — RTL is out of scope, but stop the bleeding

No RTL locale is planned; all eight website locales are `ltr`. The renderer uses
physical `left`/`right` positioning in 18 places against only two logical
properties, so Arabic or Hebrew would be a project of its own.

Adopt logical properties (`inset-inline-start`, `margin-inline`, `text-align:
start`) in all **new** CSS from now on, so the debt stops growing. Not enforced
by a guard yet.

### D20 — Installer and OS package metadata stay English

`tauri.conf.json:39–68` carries a single `shortDescription` / `longDescription`,
and Tauri v2 has no native per-locale bundle metadata — it would require separate
config overlays per locale build. Not worth it.

One cheap exception: `bundle.windows.nsis.languages` at `tauri.conf.json:56–59`
is currently unset, so the NSIS installer UI is English-only. Adding the seven
languages is a one-line change that localizes the installer's own chrome (not our
copy). Included in Phase 6 as a low-priority task.

The release pipeline needs no changes at all: locales are catalog data inside one
binary, so the four-leg matrix at `release.yml:106–120` and the exact-four-platform
assertion at `:280–290` are unaffected.

---

## Phases

Ordered by dependency. Estimates assume one engineer working primarily on this.

### Phase 0 — Spike and decide (3–4 days)

Prove the whole vertical slice on one screen before committing to the pattern.

**Tasks**

- Add `react-intl` to `apps/desktop`.
- Create `src/i18n/` with `index.ts`, `locales.ts`, and a hand-written
  `messages/en.json` covering only onboarding.
- Wire `IntlProvider` in `main.tsx` with the `onError` fallback from D5.
- Convert `onboarding/Onboarding.tsx` end to end — 9 text nodes, 5 `aria-label`s,
  and the destructive-action copy at `:298–322`, which is the most consequential
  prose in the app and therefore the right stress test.
- Hand-translate onboarding into German only.
- Add a temporary locale toggle (not the real setting yet).

**Exit criteria**

- Onboarding renders correctly in English and German.
- Existing onboarding tests pass unmodified (validating D18).
- The team agrees the key naming from D3 reads well at this scale.

**Why onboarding:** it is a single file, it is dense with hard copy, and it is
the one screen where a mistranslation has real consequences — `:298` is
"Delete local data".

### Phase 1 — Infrastructure (1 week)

**Rust**

- Add `language: LanguageSetting` to `AppSettings`
  (`crates/provider-core/src/schema.rs:1585`), a ts-rs-derived enum mirroring
  the existing `Theme` pattern, defaulting to `"system"`.
- Regenerate `packages/config-schema` bindings so the `ci.yml:85–93` freshness
  gate stays green.
- Expose it through the existing `get_settings` / `update_settings` commands
  (`main.rs:49`).

**Renderer**

- Locale resolution per D13, mirroring the site's fallback chain.
- Dynamic `import()` catalog loading, keyed on resolved locale.
- Read the resolved locale before first paint via `get_settings`, so there is no
  flash of English on startup.
- Language picker in Settings, listing native names from `locales.ts`.
- `renderWithIntl()` test helper (D18).

**Tooling**

- `formatjs extract` wired as `pnpm i18n:extract`, writing `messages/en.json`.
- `pnpm i18n:status` implementing the provenance check from D6.
- **Pseudo-localization**: an `en-XA` pseudo-locale that accents every character
  and pads strings ~40% (`Save` → `[Šààvvéé———]`). Generated from `en.json`, never
  translated, never shipped. This must exist *before* extraction finishes — it is
  the highest-leverage tool in the project and it is worthless if it arrives after
  the layout work.

**Exit criteria**

- Language survives a restart.
- `pnpm i18n:status` reports correctly against a deliberately stale key.
- The app runs end to end under `en-XA` and looks visibly broken in the places
  Phase 4 will fix.

### Phase 2 — Extract the renderer (2 weeks)

Roughly 300 sites, area by area, largest first. Keep English values
byte-identical.

**Order**

1. `workspace/settings/` — 15 files, the largest single surface.
2. `chat/` — `Composer.tsx`, `ChatView.tsx`, `ToolCallBlock.tsx`,
   `SearchCallGroup.tsx`, `ComposerSkills.tsx`, `GenerationFields.tsx`.
3. `shell/` — `Sidebar.tsx`, `SettingsSheet.tsx`, `StatusLine.tsx`.
4. `workspace/` root — `MainHead.tsx`, `ToastStack.tsx`,
   `OpenExternalLinkDialog.tsx`, `DocumentPanel.tsx`.
5. `artifacts/` — small; mostly `ArtifactEmptyState.tsx` and error boundaries.

**Restructure, do not transliterate**

- Six hand-rolled plurals become ICU `plural`:
  `chat/Composer.tsx:349`, `chat/ChatView.tsx:424`, `shell/Sidebar.tsx:236`,
  `workspace/MainHead.tsx:43`, `chat/SearchCallGroup.tsx:74–75,109`,
  `chat/ToolCallBlock.tsx:146`.
  `SearchCallGroup` is the instructive one — it already hardcodes both
  `query`/`queries` forms because English has an irregular plural there, which
  is the exact problem ICU exists to solve.
- `chat/agentTools.ts:686` (`explainToolError`) becomes one whole translatable
  message with named placeholders. Token substitution will not survive German
  word order; the sentence must be translatable as a sentence.
- `artifacts/format.ts:34–46` (`timeAgo`) moves to `Intl.RelativeTimeFormat`,
  dropping the hardcoded `'never'`, `'just now'`, `'2h ago'`.
- `lib/dayGroup.ts:13–60` — `Today` / `Yesterday` / `Earlier` become catalog
  keys; the `toLocaleDateString` calls at `:23,55` take the active locale.
- `artifacts/format.ts:11–16` (`formatSize`) moves to `Intl.NumberFormat` with
  `style: 'unit'` — `KB` is not universal and `.toFixed(1)` hardcodes the
  decimal separator.
- Composite `aria-label`s built by template literal (`MainHead.tsx:43`) become
  single messages, not concatenations.

**Policy calls made during extraction**

- Provider display names in `ProviderPicker.tsx:150–158` are brand names — not
  extracted, per D7.
- Every product mention becomes `{appName}` per D8.

**Exit criteria**

- G10 (added in Phase 6, but developed here) passes over the renderer.
- Full test suite green with no assertion rewrites beyond the restructured
  strings.
- `en.json` is complete and stable.

### Phase 3 — Rust error codes (1–1.5 weeks)

**Tasks**

- Introduce `AppError` and the `From<String>` bridge (D9) so nothing breaks.
- Convert the triaged surfaces in D10 order, starting with
  `mcp-runtime/src/consent.rs:40–56` as the pilot — three strings, high traffic,
  and it flows through `ConsentPrompt` into a dialog, exercising the whole path.
- Fix `commands/settings.rs:398` — the OS error becomes a param, not a splice.
- Add `error.*` keys to `en.json`.
- Renderer: a single `translateError(AppError)` helper at the IPC boundary in
  `ipc/client.ts`, so no call site needs to know about codes.
- The `src-tauri/src/i18n.rs` table for the D15 strings.
- Pass localized dialog titles down as command arguments
  (`branding.rs:451,492`, `skills.rs:182,199`, `chat.rs:531`).

**Exit criteria**

- Every command still returns something renderable, translated or fallback.
- Settings validation errors appear in German.
- The consent dialog is fully localized.

**Risk note:** this is the phase most likely to overrun and the most deferrable.
If the schedule slips, ship waves with items 1–2 of D10 converted and the rest on
English fallback. Nothing breaks.

### Phase 4 — Pseudo-localization and layout repair (1 week)

Run the entire app under `en-XA` and fix what breaks. The audit points at where:

- **59** `text-overflow: ellipsis` sites, concentrated in the sidebar and
  composer chrome where dynamic content already competes for space.
- **103** fixed-pixel width declarations. `styles/chat.css:974` —
  `.cbtn.model { max-width: min(220px, 42vw) }` wrapped around a truncated model
  label — is representative of the whole class.
- Stylesheets in scope: `chat.css` (1742 lines), `settings.css` (705),
  `workspace.css` (642), `document-panel.css` (610).

**Method:** screenshot every screen under `en` and `en-XA`, diff, fix the
clipping. Prefer letting containers grow, then wrapping, then truncating with a
tooltip — truncation without a tooltip is the failure mode that silently hides
information in German.

**Watch out:** `styles/cssContract.test.ts` and `shellContract.test.ts` assert
against stylesheet *text*, so CSS changes here may need matching test updates.

**Exit criteria:** no clipped or overflowing text under `en-XA` at the app's
minimum window size.

### Phase 5 — Translate and review, wave 1 (1 week + reviewer time)

**Locales:** de, es, fr.

**Process**

1. LLM-draft the full catalog per locale from `en.json`, supplying
   `glossary.md` and `do-not-translate.txt` as context, and the key name as a
   hint about where each string appears.
2. Machine checks first: ICU parses, placeholder sets match English, no
   do-not-translate term was translated, no string exceeds 1.5× the English
   length without review.
3. Native-speaker review. Prioritized, not exhaustive — the budget goes to:
   - onboarding, especially the delete-data copy at `Onboarding.tsx:298–322`;
   - the three consent permission levels from `consent.rs:40–56`;
   - settings validation errors;
   - anything the length check flagged.
4. Accepted translations update `provenance.json` (D6).

**Why review at all**, when the website shipped without it: a mistranslated
marketing paragraph costs a little credibility. A mistranslated destructive-action
confirmation or a consent dialog that understates what a connector can do costs
the user their data. The review budget follows the consequence, which is why it
is scoped to those screens rather than to all 300 strings.

### Phase 6 — Gates and ship wave 1 (3–4 days)

- **Guard G10** lands (D14), modelled on `brand/brandLiterals.test.ts`.
- Key parity and ICU validity checks in `ci.yml`'s `verify` job.
- `pnpm i18n:status` reporting in CI output.
- Update `docs/branding/README.md` — the "Custom fonts" row in its capability
  table interacts with D17.
- Optional, low priority: `bundle.windows.nsis.languages` (D20).
- Update `CHANGELOG.md`; ship de, es, fr.

### Phase 7 — Waves 2 and 3 (≈1 week each)

- **Wave 2:** ja, pt-BR. First CJK exposure — validate D17's system font stack on
  Windows, macOS, and Linux before committing to it. Japanese also stresses line
  breaking and the absence of spaces.
- **Wave 3:** ko, zh-CN. Verify the Korean font question flagged in D17.

Each wave is catalog work plus review; no code changes expected. If any are
needed, that is a signal the infrastructure has a gap worth fixing before wave 3.

---

## Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| English churns during the 2-week extraction — the app ships features weekly | High | Extract area by area and merge often; land G10 early so new code cannot add untranslated literals |
| Rust error refactor touches ~137 sites | High | The `From<String>` bridge makes it incremental; triage hard and accept English fallback for the tail |
| German layout breakage found late | Medium | Pseudo-localization in Phase 1, before extraction completes. Ordering is not negotiable |
| App and website drift into different terminology | Medium | Shared glossary (D7), adopted by both repos |
| Website translations are uncommitted and have no staleness gate | Medium | Out of scope here; the D6 mechanism would port directly |
| CJK rendering differs across platforms | Low | Validated in wave 2 before ko/zh-CN; bundling remains the documented fallback |
| Reviewer availability gates the waves | Low | Review scope is deliberately narrow (Phase 5); unreviewed strings still ship as LLM drafts, not as English |

---

## Out of scope

- **RTL support** (D19) — no RTL locale planned; 18 physical positioning sites
  would need conversion first.
- **Localized installer and OS package metadata** (D20), beyond the NSIS
  language list.
- **`docs/`, `README.md`, `THIRD-PARTY-NOTICES.md`** — none are surfaced in-app.
  `docs/support/runbook.md` is not referenced by any source file.
- **Release pipeline changes** — none needed.
- **Per-conversation reply-language override** (D12) — a reasonable follow-up.
- **Translating the marketing site's remaining gaps** — separate work in
  `pixel-website`, though it should adopt the glossary (D7) and the provenance
  mechanism (D6).

---

## Appendix A — Locale table

Mirrors `pixel-website/i18n/locales.json`. `dir` is `ltr` for all.

| Code | Native name | Wave | Notes |
| --- | --- | --- | --- |
| `en` | English | — | Source of truth |
| `de` | Deutsch | 1 | Longest strings; the layout stress case |
| `es` | Español | 1 | |
| `fr` | Français | 1 | |
| `ja` | 日本語 | 2 | First CJK; no spaces, different line breaking |
| `pt-BR` | Português (Brasil) | 2 | |
| `ko` | 한국어 | 3 | Verify font coverage (D17) |
| `zh-CN` | 简体中文 | 3 | |

## Appendix B — Key namespaces

| Namespace | Source | Approx. keys |
| --- | --- | ---: |
| `settings.*` | `workspace/settings/` (15 files) | ~120 |
| `chat.*` | `chat/` (50 files) | ~90 |
| `shell.*` | `shell/` (7 files) | ~55 |
| `onboarding.*` | `onboarding/Onboarding.tsx` | ~20 |
| `workspace.*` | `workspace/` root | ~30 |
| `artifacts.*` | `artifacts/` (17 files) | ~10 |
| `error.*` | Rust, triaged per D10 | ~40 |
| `consent.*` | `crates/mcp-runtime/src/consent.rs` | 3 |
| `common.*` | Shared verbs — Save, Cancel, Close, Dismiss | ~25 |

## Appendix C — Commands

```
pnpm i18n:extract    # regenerate messages/en.json from source
pnpm i18n:status     # missing / stale / current, per locale
pnpm i18n:pseudo     # regenerate the en-XA pseudo-locale
pnpm test            # includes G10, key parity, ICU validity
```
