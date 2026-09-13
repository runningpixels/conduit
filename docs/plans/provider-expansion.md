# Plan: Tier A provider expansion

## Status

Draft, ready for implementation. Scope is the seven Tier A providers identified
in the September 2026 market review, plus the base-URL unlock that makes the
three native adapters reusable against compatible third-party endpoints.

Every provider in Phase 1 is a **configuration change, not an adapter** — they
all speak `/v1/chat/completions` and are reachable through the existing
`OpenAiAdapter::preset(...)` seam. No new SSE parser, no new fixtures, no new
protocol code. That is the entire reason this plan is worth doing now: the
marginal cost of the eighth OpenAI-compatible provider is roughly nine lines of
Rust and four table entries.

Companion reading:
[`crates/provider-core/src/adapter.rs`](../../crates/provider-core/src/adapter.rs)
(the registry), [`crates/provider-core/src/catalog.rs`](../../crates/provider-core/src/catalog.rs)
(the descriptor table the settings UI reads),
[`docs/architecture/foundation-contracts.md`](../architecture/foundation-contracts.md)
(the credential trust boundary every new provider inherits for free).

---

## Why

Conduit ships 11 adapters. Cherry Studio ships 60+; LibreChat covers 830+
models. That gap is not itself an argument — most of those long tails are
`openai_compat` rows with a logo — but three specific things have moved since
the current list was drawn:

1. **Chinese open-weight models are now ~45% of OpenRouter token volume.**
   Conduit has zero direct providers in that segment. Users reach GLM, Kimi and
   Qwen only by paying OpenRouter's margin.
2. **Anthropic's OpenRouter share fell 29.1% → 13.3% year-over-year**, and
   OpenAI's overall API share fell 74.2% (Oct 2025) → 53.8% (Jul 2026). The
   two providers Conduit treats as first-class are now a minority of traffic.
3. **`contextWindows.ts` already carries `glm-4.5`, `glm-4.6`, `glm-5` and
   `glm-5.3-flash`.** Someone already needed those models and reached them
   through OpenRouter. The demand signal is in our own source tree.

xAI is the conspicuous absence for a Western audience — ~18% consumer share, a
serious 2026 developer push, and a built-in row in every competing client.

---

## Decisions

### D1 — Phase 1 providers are presets, not adapters

`OpenAiPresetAdapter` already wraps a configured `OpenAiAdapter` and delegates
all five trait methods. Adding a provider means adding one constructor
(`openai_preset.rs`), one registry line, and one descriptor. **Not reversible
cheaply if we get it wrong**, because the provider id becomes a keychain key
(`keychain://conduit/<provider_id>`) and an `activeProvider` value persisted in
settings. Ids are therefore fixed at implementation time and never renamed.

### D2 — Provider ids are lowercase, no vendor punctuation

`xai`, `zai`, `moonshot`, `qwen`, `together`, `fireworks`, `perplexity`.

Rationale: `activeProvider` is a free-form `string` in
`packages/config-schema/src/generated/app_settings.ts` — there is no enum to
update, and equally no schema to catch a typo. `z.ai` and `z-ai` would both
work as keychain keys and both look plausible in a diff. Pick the boring form
once. Note that `zai` deliberately does **not** match the OpenRouter model
prefix `z-ai/`, which is a model namespace, not a provider id; the two live in
different tables and do not need to agree.

### D3 — All seven land at `tier: 2`

`tier` drives display order in `ProviderPicker.tsx:161` and
`ComposerModelPicker.tsx:217` (`a.tier - b.tier || displayName.localeCompare`).
Tier 0 is "ship first" and tier 1 is "add next"; both are full. Putting seven
new rows at tier 1 would push LM Studio and Gemini down the settings list for
no reason. Tier 2 keeps the existing ordering exactly as it is and appends the
new providers alphabetically beneath it.

This is reversible — tier is presentation only.

### D4 — Qwen uses the international DashScope endpoint

`https://dashscope-intl.aliyuncs.com/compatible-mode/v1`, not the mainland
`dashscope.aliyuncs.com` host. The two are separate accounts with separate API
keys; a key from one returns 401 against the other. International is the right
default for a client shipped on GitHub releases, and users on the mainland
endpoint can override via the base-URL field (D6).

Same reasoning for Moonshot: `https://api.moonshot.ai/v1` (international), not
`api.moonshot.cn`.

### D5 — Z.ai ships as an OpenAI-compatible preset, not an Anthropic one

Z.ai exposes both: `https://api.z.ai/api/openai/v1` and
`https://api.z.ai/api/anthropic`. The Anthropic-compatible endpoint is the more
interesting one — Z.ai is the only vendor offering a genuine drop-in for the
Anthropic protocol — but routing it that way would mean either a second
Anthropic-shaped preset type (which does not exist; `AnthropicAdapter` is a
unit struct with no configuration) or shipping it as a base-URL override of the
`anthropic` provider, which would collide on the keychain key.

Ship the OpenAI-compatible endpoint as `zai`. Phase 2's base-URL unlock then
lets a user who specifically wants the Anthropic wire format point the
`anthropic` provider at `https://api.z.ai/api/anthropic` themselves. Two paths,
neither requiring new adapter code.

### D6 — Every Phase 1 preset sets `show_base_url_field: true`

The existing cloud presets (Groq, DeepSeek, Mistral, OpenRouter) all set it
`false`. That was defensible when each had exactly one endpoint. It is not
defensible for this batch: Qwen and Moonshot each have a mainland/international
split, Together and Fireworks both front self-hosted deployments, and Z.ai has
two protocol endpoints on one host.

`OpenAiAdapter` already honours `ctx.base_url` unconditionally
(`openai.rs:1262`) — the field being hidden is purely a descriptor decision.
Showing it costs nothing and removes an entire class of "I can't reach my
region" support requests.

### D7 — Perplexity ships without citation rendering, and we say so

Perplexity's Sonar models return sources as a top-level `citations` /
`search_results` array on the chat-completions response. Conduit's annotation
parser (`openai.rs:763`, `parse_openai_response_annotations`) reads
`url_citation` annotations off **Responses-API** message items only. It will
not see Perplexity's shape, so answers will stream as plain prose with no
source links.

That is still worth shipping — a Sonar answer without visible citations is a
normal answer — but it must not be discovered by a user. The descriptor
`description` says so. Wiring chat-completions-shaped citations into
`ContentAnnotation` is deliberately **out of scope** and tracked as follow-up.

### D8 — Vision flags are conservative and asserted, not guessed

`vision.rs:19` and its renderer mirror `modelAcceptsImages.ts` are two
hand-maintained switch statements with **no test asserting they agree**. Adding
seven providers to one and forgetting the other is a silent bug: the renderer
would let a user attach an image the Rust side then drops.

Phase 3 adds the parity guard. Until it exists, Phase 1 edits both files in the
same commit and the reviewer checks both. Per-provider values:

| Provider | `model_accepts_images` | Why |
|---|---|---|
| `xai` | `true` | Grok has had vision since Grok-2 |
| `zai` | heuristic | GLM-4.5V and later are multimodal; the base chat models are not. Fall through to `model_id_suggests_vision` |
| `moonshot` | heuristic | Kimi's vision support is model-specific |
| `qwen` | heuristic | Existing needles already cover `qwen2-vl`, `qwen2.5-vl`, `qwen3-vl`, `qwen-vl` |
| `together` | heuristic | Model zoo — depends entirely on the selected model |
| `fireworks` | heuristic | Same |
| `perplexity` | `false` | Sonar is text-in, text-out |

"Heuristic" means: no match arm at all. Falling through to the `_` default in
`vision.rs:26` runs `model_id_suggests_vision`, which is exactly the right
behaviour for a multi-model gateway and requires zero new code. **Do not add
`=> true` arms for the gateways** — that is what `openrouter` does today and it
is arguably already wrong.

### D9 — No hosted web search for any Phase 1 provider

`endpoint_supports_hosted_search` (`openai.rs:1419`) allowlists
`api.openai.com` by host. None of the seven match, so all seven correctly get
no hosted-search tool without any code change. Perplexity is the interesting
case — it *is* a search product — but its search is intrinsic to the model, not
a tool the client requests. Nothing to do.

### D10 — Pricing entries are omitted, not guessed

`MODEL_PRICING` (`catalog.rs:163`) and its renderer twin `costTable.ts` are
both stale — they price `claude-sonnet-4`, `gpt-4o` and `gemini-1.5-pro`, none
of which is current. Anything modern already falls through to `$0` and the
spend segment silently under-reports.

Adding seven providers' worth of 2026 prices to a table that is wrong for the
2025 entries makes the table *look* maintained while still lying. Phase 3
refreshes the whole table as one unit of work. Phase 1 adds nothing, which
leaves new providers in the same honest `$0`/omitted state as everything else.

---

## Phase 1 — the seven presets

### The nine touch points

Every provider needs exactly these. There is no tenth.

| # | File | Change |
|---|---|---|
| 1 | `crates/provider-core/src/adapters/openai_preset.rs` | `pub fn <id>() -> Self` calling `OpenAiAdapter::preset(...)` |
| 2 | `crates/provider-core/src/adapter.rs:43` | one `Box::new(...)` line in `registry()` |
| 3 | `crates/provider-core/src/catalog.rs` | one `ProviderDescriptor` in `PROVIDER_DESCRIPTORS` |
| 4 | `crates/provider-core/src/vision.rs:19` | match arm — **only** for `xai` and `perplexity` (see D8) |
| 5 | `apps/desktop/src/chat/modelAcceptsImages.ts` | mirror of #4, same commit |
| 6 | `apps/desktop/src/lib/providerIdentity.ts:23` | `DISPLAY_NAMES` entry |
| 7 | `apps/desktop/src/workspace/settings/ProviderPicker.tsx:26` | `FALLBACK_PROVIDER_BRANDS` entry |
| 8 | `apps/desktop/src/lib/contextWindows.ts` | context windows for that provider's flagship models |
| 9 | `apps/desktop/src/lib/providerIdentity.test.ts` | add the id to the "maps to custom" loop |

**What you do not need**, and this is the point of the plan:

- No SSE fixtures. `tests/fixtures/` is organised by *protocol*
  (`anthropic/`, `openai/`, `gemini/`, `ollama/`, `openai_compat/`, `zen/`),
  not by provider. All seven reuse `OpenAiParser` and are covered by the
  existing `openai/*.sse` replay tests.
- No icons or brand assets. `brand.rs` is white-labeling for the *app*; it has
  zero provider references.
- No `config-schema` change. `activeProvider` is `string`.
- No credential plumbing. `credentials.rs:140` builds
  `keychain://{service}/{provider_id}` generically.
- No `localOnly` gate work. It keys off `is_local()`, which these all return
  `false` for.
- No i18n key. Brand names are held as data in `FALLBACK_PROVIDER_BRANDS`
  precisely so guard G10 passes without an exemption (see the comment at
  `ProviderPicker.tsx:13`).

### The two invariants that already protect you

`catalog.rs` carries `every_registry_adapter_has_descriptor` and
`every_descriptor_has_registry_adapter`. Add a registry line without a
descriptor, or vice versa, and `cargo test` fails by name. Steps 1–3 are
therefore self-enforcing; steps 4–9 are not, which is what Phase 3 fixes.

### Provider table

| id | Display name | Base URL | Descriptor `description` |
|---|---|---|---|
| `xai` | xAI | `https://api.x.ai/v1` | `Grok models` |
| `zai` | Z.ai | `https://api.z.ai/api/openai/v1` | `GLM models` |
| `moonshot` | Moonshot AI | `https://api.moonshot.ai/v1` | `Kimi models` |
| `qwen` | Qwen | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `Alibaba Model Studio — international endpoint` |
| `together` | Together AI | `https://api.together.xyz/v1` | `Open-weight model catalog` |
| `fireworks` | Fireworks AI | `https://api.fireworks.ai/inference/v1` | `Open-weight model catalog` |
| `perplexity` | Perplexity | `https://api.perplexity.ai/v1` | `Sonar search models — sources are not shown inline` |

All seven: `credential_mode: Required`, `is_local: false`,
`show_base_url_field: true` (D6), `tier: 2` (D3), `extra_headers: &[]`,
`force_chat_completions: false`, `force_responses: false`.

**Note on descriptions and i18n.** `ProviderDescriptor.description` is
`&'static str` in Rust, crosses IPC as a plain string, and renders raw at
`ProviderPicker.tsx:186`. These are prose, not brand names, and they are
**not translated today** — "One API key, many models" and "Cost-efficient V4
models" ship in English in every locale. This plan adds seven more instances of
a pre-existing bug rather than creating one; Phase 3 addresses it. Keep the new
descriptions short and factual so the eventual extraction is cheap.

### Verification per provider

`OpenAiAdapter::list_models` GETs `{base}/models`. All seven expose it, so
"Test connection" in the settings UI is a real end-to-end check: enter a key,
confirm the model list populates, send one message, confirm it streams and
cancels. Do this against a live key for each provider before merging — the
whole risk surface of this phase is a wrong base URL, and a wrong base URL is
invisible to `cargo test`.

### Exit criteria

- `cargo test -p provider-core` green; both catalog parity tests pass.
- `pnpm test` and `tsc -b` green.
- All seven appear in Settings → Provider below the existing ten, sorted
  alphabetically within tier 2.
- For each of the seven: live key entered, model list populated, one message
  streamed to completion, one message cancelled mid-stream.
- `localOnly` mode hides all seven.

---

## Phase 2 — base-URL unlock for the native adapters

The cheapest high-leverage change in this plan, and it adds no providers.

All three native adapters already resolve `ctx.base_url` and fall back to a
default: `anthropic.rs:479`, `openai.rs:1262`, `gemini.rs:512`. But
`catalog.rs` sets `show_base_url_field: false` for `anthropic`, `openai` and
`gemini`, so the field never renders and users cannot reach it.

Flip it to `true` for `anthropic` and `openai`. This unlocks, with zero adapter
code:

- Z.ai's Anthropic-compatible endpoint (`https://api.z.ai/api/anthropic`)
- Moonshot's Anthropic-compatible endpoint
- MiniMax and other vendors' Anthropic-compatible coding endpoints
- LiteLLM / vLLM / self-hosted proxies fronting either protocol
- Azure OpenAI, *partially* — see the caveat below

**Gemini is excluded.** Its base URL embeds an API version path segment
(`/v1beta`) that the adapter concatenates against, and third-party
Gemini-protocol endpoints are rare enough that the support burden outweighs the
benefit. Leave it hidden.

**Azure OpenAI caveat.** A base-URL override gets you *close* but not all the
way: Azure uses an `api-key` header rather than `Authorization: Bearer`,
deployment-name-in-path routing, and a mandatory `api-version` query parameter.
Do not advertise Phase 2 as Azure support. Real Azure support is Tier B and
needs adapter work; it is out of scope here and should be scoped separately.

**Web search interaction.** `endpoint_supports_hosted_search` allowlists by
host on both the OpenAI and Anthropic sides, so pointing `anthropic` at Z.ai
correctly disables the hosted search tool rather than sending a tool the
endpoint cannot honour. This already works — add a test pinning it, because it
is the kind of thing that breaks quietly.

### Exit criteria

- The base-URL field renders for Anthropic and OpenAI in Settings.
- A live test: `anthropic` provider pointed at `https://api.z.ai/api/anthropic`
  with a Z.ai key streams a GLM response.
- A test asserting `endpoint_supports_hosted_search` returns `false` for a
  non-`api.anthropic.com` base URL, and that no hosted-search tool is
  serialised into the request in that case.
- Clearing the field restores the default endpoint (regression guard for the
  bug already noted at `openai.rs:2037`).

---

## Phase 3 — the hygiene this exposed

Phase 1 is safe to ship without these. None of them should wait long.

### 3a — Vision parity guard

Nothing asserts `vision.rs::model_accepts_images` and
`modelAcceptsImages.ts::modelAcceptsImages` agree. They are hand-maintained
duplicates of the same switch, and the failure mode is silent: the renderer
lets a user attach an image that Rust then drops from the request.

Add a guard in the family of G3/G4/G6–G10. The cheapest honest version: a Rust
test that emits the provider→behaviour table as JSON to a fixture, and a
vitest that runs the TS implementation over the same fixture and asserts
agreement across every registered provider id crossed with a fixed set of model
ids. This also catches the next person who adds a provider to one file only.

### 3b — Refresh the pricing tables

`MODEL_PRICING` (`catalog.rs:163`) and `costTable.ts` are both stale, and
`contextWindows.ts` is partly stale too. Current entries top out at
`claude-sonnet-4`, `gpt-4o`, `o3-mini` and `gemini-1.5-pro`. Everything current
falls through to `$0`, so the status line's spend segment under-reports rather
than being absent — the worse of the two failure modes.

Refresh both tables together (they are duplicates in different units — Rust
holds dollars-per-Mtok, TS holds cents-per-Mtok) and add a test asserting they
agree on the models they share. Then add Phase 1's providers.

### 3c — Re-check the DeepSeek vision flag

`vision.rs:22` hardcodes `"deepseek" => false`, dating from the V2/V3 era.
Verify against current DeepSeek V4 capabilities and either update it or leave a
comment recording that it was checked and when. Same for the blanket
`"openrouter" => true` and `"groq" => true` arms, which are gateways and should
arguably fall through to the heuristic like the new ones do (D8).

### 3d — Translate descriptor descriptions

`ProviderDescriptor.description` renders raw English at
`ProviderPicker.tsx:186` in every locale. It bypasses the catalog entirely
because it originates in Rust, which is why G10 does not catch it — the guard
scans renderer source for literals, and this literal is not in renderer source.

Fix: send a message key rather than prose across IPC, and resolve it through
`useT()` in the renderer. Roughly 12 keys once Phase 1 lands. Coordinate with
[`docs/plans/localization.md`](./localization.md) — this is the same class of
leak that plan's D14 is about, at a layer it did not reach.

---

## Out of scope

Explicitly not in this plan, recorded so the boundary is visible:

- **Azure OpenAI, AWS Bedrock, Google Vertex AI.** Tier B. Each needs real
  adapter work — deployment routing and `api-version` for Azure, SigV4 request
  signing for Bedrock, service-account OAuth for Vertex. Enterprise table
  stakes and worth doing, but a different plan with a different risk profile.
- **Perplexity citation rendering** (D7). Needs chat-completions-shaped
  citation parsing wired into `ContentAnnotation`.
- **Cerebras, SambaNova, DeepInfra, Novita, SiliconFlow, Nebius, Cohere,
  MiniMax.** All trivially addable as Phase 1-style presets once the pattern is
  proven. Held back deliberately: seven is enough to validate the approach, and
  every row added is a row someone has to keep working. Revisit after Phase 1
  ships and we see which get used.
- **A generic "add your own provider" UI.** `openai_compat` already covers this
  functionally; making it pretty is a separate product decision.

---

## Sources

Market data behind the Tier A selection, retrieved September 2026:

- [OpenRouter Q2 2026 token share leaderboard](https://apirank.vip/tutorials/openrouter-q2-2026-token-share-leaderboard/)
- [Chinese AI models top OpenRouter; Claude at 13.3%](https://tech-insider.org/au/chinese-ai-models-openrouter-2026/)
- [LLM market share comparison](https://aimultiple.com/llm-market-share)
- [AI inference providers pricing matrix, Q2 2026](https://www.digitalapplied.com/blog/ai-inference-providers-pricing-matrix-q2-2026)
- [Grok statistics 2026](https://www.getpanto.ai/blog/grok-ai-statistics)
- [Cherry Studio provider documentation](https://docs.cherry-ai.com/docs/en-us/pre-basic/providers/zi-ding-yi-fu-wu-shang)
- [Cherry Studio vs LibreChat](https://openalternative.co/compare/cherry-studio/vs/librechat)
- [Z.AI dual base URLs](https://www.layer3labs.io/guides/z-ai-api)
- [Kimi API base URL and setup](https://www.morphllm.com/kimi-api)
- [Qwen OpenAI-compatibility, Alibaba Cloud Model Studio](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope)
- [Perplexity OpenAI compatibility](https://docs.perplexity.ai/docs/agent-api/openai-compatibility)
- [xAI API reference](https://x.ai/api)

Base URLs must be re-verified against each vendor's live documentation at
implementation time. A wrong base URL is the single failure mode this plan
cannot catch with a test.
