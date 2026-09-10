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

---

## Progress

### Phase 0 — done

The spike landed and all three exit criteria hold. `pnpm test` is green at
1215 passed / 4 skipped, `tsc -b` is clean, and **no pre-existing test file was
modified** — which was the criterion that mattered, because it is the evidence
behind D18's claim that extraction costs tens of test edits rather than
hundreds.

What shipped: `react-intl` in `apps/desktop`; `src/i18n/` with the locale
table, the provider, the `useT()` seam, and 52 keys of `en.json` + `de.json`
covering `Onboarding.tsx` in full — both exported components, including the
delete-data copy; a dev-only language switch; 47 new tests.

Six deviations from the plan as written, all deliberate:

1. **`index.ts` is `index.tsx`.** The provider is a component; JSX needs the
   extension. D4's layout is otherwise unchanged.

2. **`useT()` falls back to a module-level English `IntlShape` when no
   provider is above it**, rather than every test opting in through a
   `renderWithIntl()` helper. D18 predicted "tens of edits"; the actual number
   is zero, and the helper it proposed turned out not to be needed at all.
   `useIntl()` throws without a provider, which is what would have forced the
   helper. This is the single highest-leverage decision in Phase 0 and it
   should be preserved through Phase 2.

3. **The catalog gates landed now, not in Phase 6.** Key parity, ICU validity,
   placeholder parity, and the no-literal-product-name check (D14) run in
   `src/i18n/catalogs.test.ts` as of Phase 0 — a hand-written German catalog
   with nothing checking it was not worth shipping for even one phase. **G10
   is still Phase 6**: it scans source, and there is no point scanning source
   until Phase 2 has extracted it.

4. **`resolveLocale` adds one step the website's chain does not have.** Bare
   `pt` and `zh` resolve to `pt-BR` and `zh-CN` instead of falling to English.
   `pt-PT` also resolves to `pt-BR`; `zh-TW` and `zh-HK` deliberately do
   **not** resolve to `zh-CN` — they are Traditional, a different translation,
   and serving them Simplified is worse than serving them English. This is
   worth porting back to `site.js`, where bare `pt` and `zh` currently get
   English.

5. **One extra key.** The source spliced an adjective into a sentence —
   `Removes the {size or 'saved'} backup of…` — which is the exact pattern
   Phase 2 forbids for `agentTools.ts:686`. Split into two whole sentences:
   `recovery.delete.backupOnly.body` and `.bodyUnknownSize`.

6. **Three build-config changes** the plan did not anticipate:
   `resolveJsonModule` in `tsconfig.base.json`, a hand-written `ImportMeta`
   shim in `vite-env.d.ts` (matching how the repo already shims `node:*`
   rather than pulling in `vite/client`), and
   `@formatjs/icu-messageformat-parser` as a devDependency for the gates.

**Carried into Phase 1:** a non-English cold start still shows one English
frame while the catalog import resolves. Phase 1 removes it by reading
`AppSettings.language` before first paint, and `src/i18n/devLocale.ts` is
deleted at the same time.


## Summary

### Phase 1 — done

`pnpm test` is green at 1258 passed / 4 skipped, `tsc -b` is clean,
`cargo test -p provider-core` is green, the `apps/desktop/src-tauri` suite is
green, and `packages/config-schema`'s freshness gate passes.

What shipped: `AppSettings.language` as a ts-rs `LanguageSetting` enum with
`#[serde(default)]`; the language picker in Settings → Appearance; pre-paint
locale resolution; the `en-XA` pseudo-locale; and three tooling scripts —
`pnpm i18n:pseudo`, `i18n:status`, `i18n:check`.

**Exit criteria.** Two of the three are verified; the third is verified at
every seam but not end to end, and that is worth stating plainly.

- *Language survives a restart* — **mechanism complete, unit-tested at each
  seam, not verified by launching the packaged app.** Rust persists the field
  and defaults it when absent from an existing `settings.json`; the renderer
  mirrors it to `localStorage`, reads that mirror before first paint, and
  reconciles against the authoritative Rust value in App's boot effect. Each
  link has a test. The end-to-end restart needs a real app launch.
- *`pnpm i18n:status` reports correctly against a deliberately stale key* —
  **verified live.** Editing an English string reports that one key as `stale`,
  names it, and exits 0. Deleting a German key reports it as `missing` and
  exits 1. That is exactly the D6 split: stale never fails the build.
- *The app runs under `en-XA`* — the catalog generates, loads, and round-trips
  through the resolver, and the ICU survives it (below). Running the whole app
  in it is Phase 4's job and its first real use.

**Deviations, all deliberate:**

1. **`formatjs extract` does not apply and was replaced.** D4 assumed English
   would be extracted from `defaultMessage` values at call sites. D3 chose
   hand-written ids and call sites carry only the id — there is nothing to
   extract. The useful tool is the inverse: `pnpm i18n:check` cross-references
   ids referenced in source against `en.json`, failing on used-but-undefined
   and warning on dead keys. **D4's "generated by `formatjs extract`" line is
   wrong and should be read as "hand-authored, verified by `i18n:check`".**

2. **The pseudo-locale has no `LanguageSetting` variant, on purpose.** It is in
   `LOCALES` so the resolver and loader can reach it, but not in
   `SHIPPED_LOCALES`, so it never appears in the picker — a user who selected
   it would get `[Šààvvéé———]` with no obvious way back. It is reachable only
   through the dev override.

3. **`src/i18n/devLocale.ts` was not deleted.** Phase 1 planned to remove it
   once the real setting landed. It stays, because it is now the only route to
   the pseudo-locale, and its module comment says so. `I18nProvider` gained an
   `overridden` flag so App's reconcile cannot undo `?locale=en-XA` the moment
   settings load.

4. **Pre-paint is a cache read plus a catalog await, not an IPC await.**
   Blocking first paint on `get_settings` would delay every launch. Instead
   `main.tsx` reads the `localStorage` mirror synchronously and awaits the
   catalog's dynamic `import()` — a microtask, and nothing at all for English.
   Same replay-then-reconcile shape `applyCachedBrand` already uses.

5. **`renderWithIntl()` awaits the catalog before rendering.** Letting the
   provider load it leaves a frame of English, and a test written against that
   frame passes whether or not the translation ever arrives.

6. **A new guard, not in the plan: Rust ↔ TypeScript locale agreement.**
   `LanguageSetting` is a Rust enum, the locale table is TypeScript, and
   nothing connected them. Add a locale to one and not the other and either
   the setting cannot persist or a stored preference is silently dropped —
   neither is a type error. `locales.test.ts` now reads the generated binding
   as text and pins it to `['system', ...SHIPPED_LOCALE_CODES]`.

7. **`i18n-pseudo --check` compares ignoring line endings.** It is a
   generated-file freshness gate and the file is generated with LF, so on any
   Windows clone (`core.autocrlf`) a raw text comparison reports a clean tree
   as stale. Verified against a CRLF copy.

8. **18 test fixtures gained `language: 'system'`.** Adding a required field to
   `AppSettings` breaks every TypeScript object literal that builds one. This
   is unrelated to D18 — string extraction still costs no test edits; this is
   the ordinary cost of a schema field, and any past field addition paid it.

**Found, not fixed (Phase 2 owns it):** `formatBytes` in `Onboarding.tsx`
renders `2.5 MB` where German wants `2,5 MB` — `.toFixed(1)` hardcodes the
decimal separator. It is on D16's list. The German test asserts the shape
rather than the separator, so a passing suite does not cement the bug.

**Carried into Phase 6:** the three scripts are not yet wired into `ci.yml`.
D14 puts that in Phase 6 alongside G10; nothing else depends on it.

### Phase 2 — done

`pnpm test` is green at 1280 passed / 4 skipped, `tsc -b` is clean, and all
three i18n scripts exit 0. `en.json` holds **1028 keys**, every one of them
referenced from source and none referenced but undefined.

The renderer is extracted: 54 files, 587 sites — nearly double the ~300 the
plan estimated, because that figure came from grep and this one came from the
TypeScript AST.

**Guard G10 landed here, not in Phase 6.** It was built first, as a burn-down:
files still holding literals were listed, a file *not* listed could hold none,
and a file whose last literal was extracted *had* to be removed or the guard
failed. That made every area's progress verifiable without trusting a report,
and the list could only shrink. It reached empty, so the list is gone and G10
is an ordinary guard.

It parses with TypeScript rather than scanning text, unlike G8/G9. Those hunt
one known string; G10 has to decide whether a literal is *rendered*, which
depends on syntactic position — `'Save'` is a violation as JSX text and fine
as a `className`, an object key, or an enum value. Across ~600 sites the false
positives would have made it a guard people silence.

**Four things the guards could not see, each found by looking rather than by
being told:**

1. **Toasts.** `onStatus('Saved')` is an ordinary call expression. `useAutoSave.ts`
   has no JSX at all, so it never entered the list and no extraction pass was
   aimed at it — while rendering "Settings save failed" in English under a
   German UI, inside an area already reported finished. G10 now covers status
   callbacks.
2. **Prose returned from plain functions.** `parseGenerationDraft` handed five
   English validation sentences to its callers. They travel as message ids now.
3. **`packages/ui`.** The plan's inventory says it "is effectively copy-free…
   needs no translation layer". It was not: `ConfirmDialog` hardcoded "Type X
   to confirm", and `confirmLabel`/`cancelLabel` had English *default parameter
   values* — invisible to any JSX scan, and six of seven dialogs relied on
   them. Both are required props now, so the compiler finds any omission, and
   the package is copy-free for real.
4. **A whole namespace, invisible to the key checker.** `app` was missing from
   the feature-area list, so 56 live keys were reported as dead. Believing that
   report would have meant deleting them.

**D16 in full.** Every formatter now follows the chosen language rather than
the OS: sizes, counts, compact context windows, money, wall clock, relative
times, day grouping, and three bare `.localeCompare()` sorts.
`Intl.RelativeTimeFormat` at `style: 'narrow'` produces exactly the English the
hand-rolled version did — `2h ago`, `5m ago`, `3d ago` — so that swap cost
English nothing while giving German and Japanese correct output. Sizes did
change: `4.2 KB` → `4.2 kB`, CLDR's spelling, which is the point since `KB` is
not universal and `.toFixed(1)` forced a `.` on every German reader.

**Deviations worth recording:**

- **D4's `formatjs extract` still does not apply**, as recorded in Phase 1.
  `pnpm i18n:check` is the inverse and did real work here.
- **Rich text was not in the plan and turned out to be required.** Sentences
  with a styled fragment in the middle appeared in every area. Splitting them
  freezes English word order; dropping the markup loses the styling. Both were
  tried by extraction passes before `useRichT` existed. ICU tags inside the
  message keep the sentence one translatable unit; the tag set is fixed in
  code (`code`, `strong`, `b`, `em`, `kbd`, `action`) so a catalog cannot
  introduce markup the app did not sanction, and the parity gate treats a
  dropped or invented tag as a failure.
- **Two latent bugs localization would have activated**, both comparing
  *display text* to make a decision: `st.label === 'sign in'` in
  `ConnectorsSection`, and an `aria-label` identity check in `App.tsx`. Both
  now compare stable ids.
- **`common.*` is limited to action verbs.** Nouns stay per-area: "Provider" as
  a section heading and as a table column can want different German words.
- **Brand names are data, not catalog entries.** Ten provider names briefly
  became pass-through keys, which is ten chances for a locale to return a
  translated brand. They are held as data and rendered through a JSX
  expression.

**Carried into Phase 4:** the pseudo-locale now covers all 1028 keys, which is
what makes the layout pass possible. Nothing else is outstanding.

### Phase 3 — done, to the depth the plan asked for

`cargo build`, `cargo fmt --check` and `cargo test` are green; `pnpm test` is
1280 passed / 4 skipped; `tsc -b` is clean. `en.json` holds **1074 keys**, all
referenced, none undefined.

**The seam.** `AppError { code, params, fallback }` in `provider-core`, with
`From<String>` so every un-triaged `Err` keeps compiling and behaving exactly
as before. On the renderer, `IpcError` + `translateError` + an `invokeCommand`
wrapper every command goes through.

`IpcError` deliberately does **not** extend `Error`. Every existing catch site
does `String(e)`, and `String(new Error('x'))` is `"Error: x"` — subclassing
would have prefixed a hundred toasts overnight. A plain class with a
`toString` keeps them byte-identical, which is what makes converting call
sites optional rather than urgent.

**Converted (D10 items 1–3):** all of `validation.rs` (16 codes), the three
`PermissionLevel` descriptions, and the credential/keychain surface (16 codes).
`commands/settings.rs`, `state.rs` and `credentials.rs` moved to `AppError`.

**`ConsentPrompt` was restructured, not translated.** It carried
`expected_effect: String` — a sentence *composed in Rust* from a permission
level and a tool description. It now carries `permission_level` and
`tool_description`, and the renderer composes. `expected_effect()` had no other
consumer and is gone. A test that asserted on a substring of the composed
English now asserts on the typed level, which is strictly stronger.

**Not converted, deliberately (D10 items 4–6):** `stream_manager.rs` tool-call
status lines, `commands/chat.rs` workspace validation, and `db/mod.rs`'s
`DbError`. The plan calls this phase the most deferrable and says the value
stops here; those keep `error.unknown` with an English fallback, which is the
honest resting state the plan describes. Two narrow `.map_err(|e| e.fallback)`
shims exist where a converted function is called from an unconverted one —
`save_provider_secret` and `build_adapter_context`. They are seams to collapse,
not permanent.

**Deviations:**

1. **D15's Rust-side string table was not built, because it is not needed.**
   All three surfaces reach the renderer instead:
   - Native file dialogs take `dialogTitle` and `filterName` as command
     arguments (7 commands).
   - The OAuth callback page threads its two sentences down the same way; the
     chain is only three functions deep. `{detail}` rides through untouched
     because only Rust, at callback time, knows what the authorization server
     said — the alternative reassembles the sentence in Rust, in an order no
     translator can change.
   - The migration marker file is **not** localized. It is only ever written
     and deleted (`local_data.rs` never reads it back), so it is a support
     breadcrumb on disk, not UI. D15 listed it as a user-facing string; it is
     not one.

   The result is what D9 wanted in spirit: **no second catalog in Rust at all.**

2. **`i18n-check` now scans Rust.** Phase 3 put catalog keys in `.rs` files,
   and a TypeScript-only scan reported all 32 of them as dead. A dead-key
   report that lists live keys is one people learn to skip. Key shape also
   tightened to three-plus segments, because `chat.md` and `settings.json` are
   filenames that start with a real feature area.

3. **A hardcoded bound was removed from the catalog.** `error.validation.stopSequenceCount`
   read "At most 8 stop sequences." with the limit baked into English, while
   the real limit lives in `validation.rs` *and* in `GenerationFields.tsx`. It
   takes `{max}` now — the catalog no longer asserts a number it does not own.

**Exit criteria, honestly.** Every command returns something renderable, and
the consent dialog and settings validation now render *through the catalog*
with correct codes and parameters. They display **English** until wave 1
translates `error.*` and `consent.permission.*` in Phase 5 — the D5 fallback
working as designed, not a gap in this phase.

### Phase 4 — done for what a source scan and a browser can decide

Two halves, both delivered, and the boundary between them is worth being
precise about.

**The half that is decidable from source.** 22 elements clipped their text with
no way to read it; 20 are fixed and **Guard G11** keeps it that way. This is
worth a guard rather than a sweep because the bug is invisible in the language
it is written in: English fits, the ellipsis never appears, nobody notices the
value is unreachable — and German finds it months later.

**The half that needs a real layout engine.** `pnpm test:layout` (opt-in,
Playwright) walks the shell and all fourteen settings panes at two viewports
and measures, rather than eyeballing screenshots. It is differential: an
element clipping in *both* locales is by-design truncation, one that clips only
in a longer language is the bug. It runs against `en-XA` **and** real German.

Scoped so nobody pays for it who does not want it: the specs sit outside
vitest's include glob, `@playwright/test` has no postinstall, and the config
drives a Chrome or Edge already on the machine. A clone pays 13 MB and no
browser download; `pnpm test` and CI are untouched.

**The plan's numbers were both wrong, in opposite directions.** It cites "103
fixed-pixel width declarations" as the risk surface: there are 85, 63 are
square icon boxes, and exactly two constrain translated text — both already had
a tooltip. Meanwhile the truncation-without-reveal count it does not give was
22, which was the real content of the phase.

**Corrections found by running it:**

- **The pseudo-locale was simulating a URL, not German.** Padding was one
  unbroken 67-character run of em dashes, which nothing will break inside, so
  every padded string became an unbreakable token that overflowed narrow
  containers. German is longer word by word; it is not one enormous word. The
  padding is chunked now — same length, still obviously fake, wrappable. Had
  this not been fixed, every long string would have "overflowed" somewhere and
  the real findings would have drowned.
- **The first version of the browser check could not fail.** It passed
  immediately, and still passed with the known bug reintroduced. The reason is
  worth keeping: that bug was not clipped text but content spilling out of an
  `overflow: visible` box, surfacing on an ancestor scroll container. The
  detector skipped `auto`/`scroll` boxes as "meant to scroll" — hiding exactly
  the case it existed to find.

**Not covered:** `dev:web` has no Tauri backend, so anything behind IPC — a
populated conversation, the connector list, the consent dialog — never renders.
Those need the real build.

### Phase 5 — wave 1 translated; native review still outstanding

`de.json` goes from 72 to **1076 keys**: complete, zero missing, zero orphaned,
every ICU message parsing with placeholder and inline-tag parity against
English. `i18n:status --strict` passes and provenance is stamped, so from here
an English change surfaces as `stale` rather than silently diverging.

**The prerequisites did not exist and had to be written first.** D7 calls for a
glossary and a do-not-translate list; neither had been. The German column is
read out of the copy already translated and reviewed in the Phase 0 spike
rather than invented, so the catalog stays consistent with what shipped. Two
entries where the obvious choice is wrong are recorded: *memory* →
*Gespeicherte Fakten*, because *Erinnerung* reads as reminiscence and
*Speicher* is already the local store in the recovery copy; *workspace* →
*Arbeitsbereich* rather than the loanword, unlike *Skill*.

The do-not-translate list holds **names** — Anthropic, MCP, JSON, API — not
"English words". Ordinary words like *connector* translate; they just have to
translate consistently, which is the glossary's job. A gate reads that file
directly, so the list a translator is handed and the list the build enforces
cannot drift.

**`SHIPPED_FOR_RELEASE` now contains `de`.** A locale joins that list when it
is complete, not when it ships — the two are different decisions, and this is
the one that stops it rotting: an English key added without a German one now
fails on the commit that adds it.

**Translation found three source bugs that extraction had missed**, each the
same shape — an English word spliced into a sentence:

1. `ACTION_BY_TOOL` produced `Create`/`Edit` and `KIND_BY_TOOL` produced
   `HTML`/`Text`, both rendered straight into the UI. G10 never saw them: they
   are assigned into a template literal, not JSX text or a toast. They are ids
   now, resolved through an ICU `select` so German inflects the participle
   instead of receiving an English infinitive.
2. `keychainMode.fileBody` was split into `.before` + `<code>VAR</code>` +
   `.after`, freezing English word order. The translator had to move the join
   point between the halves to fake a German compound. It is one message with
   a `<code>{envVar}</code>` tag now.
3. The English itself is not self-consistent: it calls the same stored record
   both "chat" and "conversation", and the same three settings both "flags" and
   "toggles". German unified each; the English is worth tidying.

**What is still outstanding, and it is the point of the phase:** native review.
The machine checks the mechanical half — ICU, placeholders, tags, do-not-
translate, no hardcoded product name. It cannot check that the glossary was
followed, and consistency of word choice is exactly what a reviewer is for. The
plan's priority list stands: onboarding's delete-data copy, the three consent
permission levels, and the settings validation errors.

Also outstanding: **es and fr**, which the same pipeline now produces.


The website was localized by duplicating whole HTML pages. That approach is
correct for four static marketing pages and **fatal** for an app that ships
features weekly: there is no string catalog and therefore no mechanism to
detect that English changed. The seven translated copies of the site are
already free to drift, silently, and nothing reports it.

Conduit needs the opposite shape: one English catalog as source of truth, six
sibling catalogs generated from it, and CI that fails when they diverge. This
#### Spanish and French

Both are complete on the same terms as German: **1076 keys each**, zero missing,
zero orphaned, ICU valid, placeholder and tag parity against English, and
provenance stamped. `i18n:status --strict` reports 3228 current keys and nothing
stale. The layout walk now covers `fr` alongside `en-XA` and `de` at both
viewports — eight checks, all passing, nothing clipping under French that does
not already clip under English.

The glossary gained Spanish and French columns, and three places where those two
should *not* copy German are written down with the reason (German's *memory*,
*connector* and *tool call* entries are all workarounds for German-specific
collisions).

#### What translation found that the guards could not

Four defects, none of which any existing gate could see, because every one of
them is a string that is correctly translated and still wrong:

1. **English named a section that does not exist.**
   `settings.privacy.trust.noKey.detail` sent the user to "Provider & Model".
   The section is "Providers & keys" — in the nav, the heading and the sidebar
   menu. German, Spanish and French had each faithfully translated the wrong
   name, which is precisely what a good translator does.
2. **French named one element two ways.** The composer chip is labelled
   *Paramètres du chat*; `settings.generationControls.intro` told the user to
   look for a chip called *Réglages de la conversation*. Two translators, two
   slices, no shared word for the app's own furniture.
3. **Spanish did the same thing four times.** The settings sheet is titled
   *Configuración*, and four separate strings told the user to go to *Ajustes*.
4. **The type-to-confirm dialog compared raw code points.**
   `phrase.trim() === confirmPhrase` was harmless while every phrase was ASCII.
   Once the phrases became *alle löschen* and *réinitialiser*, a keyboard or
   paste source emitting the decomposed form produced a string that looks
   identical in the input and fails the comparison — the confirm button stays
   disabled with nothing on screen explaining why. Now compared in NFC, with a
   test that fails without the fix.

The first three share one cause: a UI element's name is duplicated as free prose
in another key, and nothing ties the two together. **Guard G12**
(`i18n/uiCrossReferences.test.ts`) now checks that a sentence naming an element
contains that element's own label, per locale, comparing content words after
folding away case, accents, punctuation and articles so that legitimate
rephrasing passes. It found all three, and one entry of its own registry that
was wrong — English's "Add a provider key…" is an instruction that happens to
share three words with the "Add a provider" button, not a reference to it, and
German's correct translation would never contain the button's name.

The glossary now carries the app's own furniture (the settings screen, and
generation *parameters* kept distinct from it) rather than only product
concepts, because that gap is what split French.

Two smaller repairs: German's `error.validation.stopSequenceLength` fused
*Stoppsequenzen* where the field is labelled *Stopp-Sequenzen*, and
`i18n-status --accept` reads as repeatable but silently honoured only the first
locale, so stamping three locales after a shared English edit was a no-op for
two of them.

#### The naming pass, and why it came before wave 2

Translating the same UI three times surfaced a defect English had all along:
**the app called its own parts by more than one name, and every locale
inherited the split and made it worse.**

English called the stored record a "chat" in 57 keys and a "conversation" in
39. On the user's decision it now says *chat* everywhere, and the 44 affected
strings were rewritten. Each locale then had to collapse its own split, and
**they did not collapse the same way** — which is the whole argument for a
per-locale glossary rather than a translated English one:

| | record | reasoning |
| --- | --- | --- |
| German | *Chat* | What German messaging UI says; 4 characters against 12; already the word inside every compound label the app ships. Forced a gender change (*die Unterhaltung* to *der Chat*) through roughly ten strings. |
| Spanish | *chat* | Same, plus *la conversación* drags agreement through 49 strings in a width-constrained UI. |
| French | *conversation* | **In French, *chat* is the word for "cat".** The rename would have put a bare, unqualified *Chats* in the sidebar landmark, the command-palette heading and the search placeholder — the three places with no context to disambiguate it. The width cost is paid deliberately. |

Underneath that, one element had no agreed name at all. English called the
composer "the composer" in seven strings and "the chat bar" in three; German
had three renderings, Spanish five, French five. All three locales
independently rejected the calque — `Composer` reads as *Komponist*, and
*compositor* / *compositeur* are people who write music — and Spanish and
French independently anchored on the skip link, the one place the element names
itself to a screen reader.

Four English defects fell out of the same pass. `settings.privacy.trust.noKey`
pointed at a section that has never existed. The sidebar's `<aside>` and its
`<nav>` were briefly both "Chats", which a screen reader announces as "Chats
region, Chats navigation". `chat.errorBoundary.detail` said "the chat thread",
a third noun for the record, which forced German into *Chatverlauf* and
collided with "chat history". And renaming the palette entry to "Settings for
this chat" — which matched its siblings — silently broke discoverability:
typing the chip's own name stopped finding the command.

**Guard G13** now enforces what G12 cannot. G12 compares a sentence against the
label of the element it names, which only works when the element *has* a label;
the composer is a region whose only name is a visually-hidden skip link.
Registering that link as a G12 target fails on correct translations, because
its text is "Skip to composer" and no sentence mentioning the composer contains
"skip" — the Spanish translator caught that, and it is why G13 pins the settled
word per locale instead, failing loudly when a locale has no row. The table is
hard-coded on purpose: a rendering inferred from the catalog can only discover
what is already there, so it would bless a split rather than catch one.

#### Accessibility and D17, which the same pass unblocked

`index.html` shipped `<html lang="en">` and nothing ever moved it, so every
locale was announced to a screen reader in an English voice — the one i18n
defect a sighted reviewer cannot see. `I18nProvider` now sets `lang` and `dir`
from the resolved locale.

That is also the prerequisite for D17. Geist carries no CJK, so Japanese,
Chinese and Korean reach the browser's per-character fallback, which picks *a*
font with the glyph — and Han characters are unified across the three languages
at the code-point level but drawn differently, so a Japanese UI on a machine
carrying a Chinese font can render kanji in Chinese letterforms. `lang` breaks
the tie; explicit per-language stacks in `tokens.css` (UI, mono **and** serif,
since Source Serif 4 has no CJK either) name the platform face rather than
trusting the guess.

One shipping gap closed alongside: the language picker offered all eight
locales while only four had catalogs, so selecting 日本語 saved the setting,
crossed into Rust, and changed nothing on screen. It now offers only what it
can render, derived from the same glob that loads the catalogs.

**Still outstanding:** native review of de/es/fr, which is the point of this
phase and cannot be done by an agent.

### Phase 7, wave 2 — ja and pt-BR are complete; native review outstanding

`i18n:status --strict` reports **5380 current keys across five locales**, zero
missing, zero stale, zero orphaned. Both new catalogs are 1076 keys, ICU-valid,
placeholder- and tag-identical to English, and stamped. `SHIPPED_FOR_RELEASE`
and the G12/G13 catalog lists gained both. Full suite green at 1362 passed /
4 skipped, `tsc -b` clean, and the layout walk passes 12 checks with `pt-BR`
and `ja` added to it.

**This wave settled terminology before splitting the keys, which is the one
process change wave 1 earned.** Every wave-1 locale shipped with two names for
something because the words were agreed after the split; nothing like that
happened here. The glossary carries Japanese and Portuguese columns, and the
four rows worth arguing about are written down with the reason:

- **memory — 記憶, not メモリ.** German's problem in a second language: メモリ
  is RAM to a Japanese reader exactly as *Speicher* is disk to a German one.
- **composer — 入力エリア, not 入力欄.** Japanese draws the region/field line
  harder than anywhere else, because 入力欄 is the ordinary word for a text
  input and this app has dozens. It reaches German's *Eingabebereich*
  independently. コンポーザー was rejected for the reason all four earlier
  locales rejected the calque.
- **chat — チャット and *chat*, both loanwords.** pt-BR is the interesting one:
  its own messaging apps say *conversa* and it still takes *chat*, because
  *conversa* carries the act-of-talking sense the glossary has forbidden since
  German, and unlike French there is no homograph to run from.
- **settings — Configurações, not Ajustes.** *Ajustes* is the European
  Portuguese and Apple word; this app is Windows-first, the same reason French
  rejected *Réglages*.

**Japanese needed one decision no Latin-script locale has: a type-to-confirm
phrase has to survive IME conversion.** The confirm gate compares NFC-equal
strings exactly, so a phrase whose reading has two common conversions can leave
the button disabled while the input looks right. *reset* → リセット is direct
katakana with no conversion step at all. *delete all* → すべて削除 is the
riskier of the two — すべて and 全て are both valid conversions of the same
reading — and is accepted because the dialog prints the phrase directly above
the field, so a mismatch is visible rather than silent. Worth revisiting if
anyone reports it; worth recording either way, because wave 3 hits it again in
Korean and Chinese.

#### What translating this wave found

**One live rendering bug, shipped in three locales for a full wave.** The
domain-list placeholders held a literal `&#10;` HTML entity. It is a
`<textarea>` placeholder, which does not decode entities — so it rendered as
five visible characters. The English fix landed in the previous commit and
**nothing carried it into de, es or fr**, which have been showing it ever
since. Every gate stayed green because an entity is not a placeholder, so
parity had nothing to compare, and it is not a product name or a
do-not-translate term. It surfaced here only because translating the same two
strings produced values identical to English, which is the one thing a
wave-2 pass looks at hardest.

All three catalogs are fixed, and **`catalogs.test.ts` now rejects any HTML
character entity in any catalog value, English included** — a catalog value
reaches the user as text, never as markup, so an entity is never right. The
supported inline tags (`<code>`, `<strong>`) are real ICU tag elements and are
unaffected.

**The layout walk's list was renamed, because Japanese broke its premise.** It
was `LONGER_LOCALES` — the check exists to find text that clips under a
language longer than English. Japanese is *shorter* almost everywhere and will
never fire that finding. What it can find is the other half of the same
failure: no spaces means no break opportunity unless the browser applies CJK
line breaking, and a container tuned for English word wrapping spills instead —
which shows up in the identical measurement. It is `MEASURED_LOCALES` now, with
`ja` and `pt-BR` in it. Nothing clips under either that does not already clip
under English, at both viewports.

#### D17, and the half of it that is still open

The walk now asserts the **wiring**: `html[lang]` follows the resolved locale,
and the `:lang`-gated stack in `tokens.css` actually reaches the DOM and
differs from the Latin default. Both are one attribute and one selector away
from silently doing nothing, and that is the part that can regress.

**It does not validate the glyphs, and cannot.** Whether kanji are drawn with
Japanese rather than Chinese letterforms depends on which fonts the machine
has. This was exercised on **Windows/Chrome only**. The plan asks for Windows,
macOS and Linux before wave 3 commits to the stack, and macOS and Linux still
need a human in front of the real build.

**Still outstanding:** native review, now of five locales rather than three.
Unchanged in kind — the machine checks ICU, placeholders, tags, verbatim names,
entities and cross-referenced element names; it cannot check that the glossary
was followed or that a sentence reads naturally.

### Phase 7, wave 3 — ko and zh-CN; every locale in the table now ships

`i18n:status --strict` reports **7532 current keys across seven locales**, zero
missing, zero stale, zero orphaned. `SHIPPED_FOR_RELEASE` holds all seven and
the G13 table has a row per locale, so the whole set is now held to English.
Full suite 1388 passed / 4 skipped, `tsc -b` clean, layout walk 18 checks green.

Terminology was settled first again. Korean and Chinese mostly confirm the
earlier waves — 기억 / 记忆 for *memory* (메모리 and 内存 are both RAM, which is
Japanese's argument in two more languages), 입력 영역 / 输入区 for the composer
against 입력란 / 输入框, 채팅 / 聊天 for the record. **Chinese is the first
locale to break the *skill* row**, and the reason is script rather than
meaning: the five earlier locales all write Latin natively, so *Skill* sits in
a sentence without looking foreign, and in a Chinese label it does. 技能
survives the "reads as an innate capability" objection because 技能包 and
SKILL.md carry the package sense around it. The same locale then keeps *Token*
in Latin on the very next row, because 令牌 is an **auth** token and 词元 is
academic — 技能 has a correct everyday word and *token* does not.

#### G12 earned its keep on the first run

Adding the two catalogs failed the build immediately, on Chinese:

> `chat.view.status.chatSettingsSaved` points at `chat.composer.chatSettings.ariaLabel`
> ("聊天设置") but says "设置只为本次聊天保存".

The chip is 聊天设置; the sentence put 设置 before 聊天, so the chip's own name
never appears in the sentence that sends the user to it. That is the same
defect that shipped in French, Spanish four times, and English itself before
the guard existed — caught this time before a line reached the repo, by the
subsequence matcher wave 2 built and could only test synthetically. Fixed to
"聊天设置已保存，仅对本次聊天生效".

One test had to be rewritten rather than repointed: `loadMessages` returns
English for a listed locale whose catalog has not landed, and it asserted that
using `ko`. Every locale in the table now has a catalog — the correct end state
— so it derives the untranslated set instead and additionally exercises the
branch with a code the glob has nothing for, which is what the branch actually
keys on.

#### D17's Korean footnote, verified — and it was right

The plan flagged the website's Korean font as ~156 KB against ~1.1 MB for
Japanese and Simplified Chinese and guessed a partial Fontsource slice rather
than full Hangul. **It is a partial slice.** Rendering each sampled character
twice — once with the file ahead of a system Korean face, once with the system
face alone — and comparing bitmaps shows only **305 of 699 sampled Hangul
syllables (44%)** are actually in `NotoSansKR-Regular.woff2`. U+D7A3 힣, U+B915
뉕 and the whole conjoining-Jamo block at U+1100 fall back; `cjk.css` declares
`unicode-range: U+1100-11FF, U+3130-318F, U+A960-A97F, U+AC00-D7AF`, so it
claims coverage the file does not have.

Two notes on reading that number. Hangul is a closed algorithmic set of 11,172
syllables that a complete Noto Sans KR covers in full, so anything short of
~100% is a subset — unlike Han, where the same method scores JP and SC at 29%
and 34% simply because no Noto Sans covers all 20,000 CJK ideographs. And the
user-visible symptom is not tofu on most machines but *mixed typefaces*: the
browser still falls back per character, so common syllables render in Noto Sans
KR and rarer ones in whatever the system provides. On a machine with no Korean
font — the case bundling exists to serve — it is tofu.

**This is website work, not app work.** The app bundles no CJK at all (D17) and
its stacks are validated below. Filed for `conduit-website`: re-slice the Korean
face at full Hangul coverage, or narrow the declared `unicode-range` to what
the file actually carries.

#### D17 in the app, now checked for all three CJK locales

The layout walk asserts per locale that `html[lang]` follows the resolved
locale and that the `:lang`-gated stack reaches the DOM naming its platform
face — Yu Gothic UI for `ja`, Malgun Gothic for `ko`, Microsoft YaHei UI for
`zh-CN`. Three separate CSS rules, so one silently failing to match is a real
regression and now fails a test. Nothing clips under `ko` or `zh-CN` that does
not already clip under English, at both viewports.

**Unchanged from wave 2: this validates wiring, not glyphs, and it ran on
Windows/Chrome only.** Whether kanji are drawn with Japanese rather than
Chinese letterforms depends on the machine's fonts, and macOS and Linux still
need a human in front of the real build.

**Still outstanding:** native review, now of all seven locales. That is the
whole remaining gate — the machine's half is complete.

---

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
>
> **Verified in wave 3, and correct.** Only 305 of 699 sampled Hangul syllables
> are in `NotoSansKR-Regular.woff2`, while `cjk.css` declares the full
> `U+AC00-D7AF` block plus both Jamo ranges. Korean visitors get mixed
> typefaces, and tofu on a machine with no Korean font. Fix belongs in
> `conduit-website`: re-slice at full coverage, or narrow the declared
> `unicode-range` to the truth. See the wave-3 progress note above for method.

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
