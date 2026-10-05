//! Model prices and cost estimates.
//!
//! A price is resolved in this order, first hit wins:
//!
//! 1. **Override**: a price the user set in Settings for this provider and model.
//! 2. **Provider**: the price the provider reported in its own model listing this
//!    session. Only OpenRouter publishes one (`pricing` on `/models`).
//! 3. **Snapshot**: `data/model-prices.json`, a filtered copy of the models.dev
//!    catalog embedded at build time. The app never fetches models.dev itself;
//!    `scripts/update-model-prices.mjs` refreshes the file before a release.
//! 4. **Retired**: a short table of models that left the snapshot but appear in
//!    older usage, so history keeps a cost.
//! 5. **Local**: Ollama and LM Studio cost nothing per token.
//!
//! Anything else has *no* price, which is not the same as costing nothing: the
//! UI shows it as unpriced instead of charting $0.
//!
//! ## Units and cache tokens
//!
//! Prices are USD per million tokens. Providers disagree on what "input tokens"
//! means: Anthropic reports input *excluding* cache reads, while OpenAI-style APIs
//! (and OpenRouter, and every preset built on them) and Gemini report input
//! *including* the cached part. [`estimate_cost_usd`] subtracts cache reads for
//! the latter, or a cached prompt would be billed twice.
//!
//! ## Known limit: long-context tiers
//!
//! Some models charge more once a single request passes a context size. Usage is
//! stored per turn with tokens summed across agent rounds, so the size of any one
//! request is gone by the time a cost is computed. Base prices are used for every
//! request; the snapshot generator drops tier data for that reason.
//!
//! ## Model facts
//!
//! The snapshot also carries two facts per model from models.dev: its context
//! window ([`snapshot_context_window`], for the status line's context gauge) and
//! whether it takes image input ([`snapshot_accepts_images`], for the vision
//! gate in `vision.rs`). Only priced models are in the snapshot.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Deserialize;

use crate::schema::{ModelPrice, ModelPriceOverride, PriceSource, ResolvedModelPrice};

const SNAPSHOT_JSON: &str = include_str!("../data/model-prices.json");

/// Providers whose models run on the user's machine and cost nothing per token.
const LOCAL_PROVIDERS: &[&str] = &["ollama", "lmstudio"];

/// Models that are gone from the snapshot but appear in older usage. Prices are
/// copied from Conduit's original hand-kept table and are not updated. Columns:
/// input, output, cache read, cache write; a zero cache price means the old
/// table did not know it, and the input price is charged instead. Dated ids
/// (`claude-opus-4-20250514`) reach these through [`candidate_ids`].
const RETIRED: &[(&str, &str, f64, f64, f64, f64)] = &[
    ("anthropic", "claude-sonnet-4", 3.0, 15.0, 0.30, 3.75),
    ("anthropic", "claude-3-5-sonnet", 3.0, 15.0, 0.30, 3.75),
    ("anthropic", "claude-opus-4", 15.0, 75.0, 1.50, 18.75),
    ("anthropic", "claude-3-haiku", 0.25, 1.25, 0.03, 0.30),
    ("openai", "gpt-4o", 2.50, 10.0, 1.25, 2.50),
    ("openai", "gpt-4o-mini", 0.15, 0.60, 0.075, 0.15),
    ("openai", "o3-mini", 1.10, 4.40, 0.55, 1.10),
    ("gemini", "gemini-1.5-pro", 1.25, 5.0, 0.0, 0.0),
    ("gemini", "gemini-1.5-flash", 0.075, 0.30, 0.0, 0.0),
    ("gemini", "gemini-2.0-flash", 0.10, 0.40, 0.0, 0.0),
];

#[derive(Deserialize)]
struct SnapshotFile {
    #[serde(rename = "fetchedAt")]
    fetched_at: String,
    providers: HashMap<String, HashMap<String, SnapshotEntry>>,
}

#[derive(Deserialize)]
struct SnapshotEntry {
    i: f64,
    o: f64,
    #[serde(default)]
    cr: Option<f64>,
    #[serde(default)]
    cw: Option<f64>,
    /// Context window in tokens (models.dev `limit.context`).
    #[serde(default)]
    c: Option<u64>,
    /// Whether the model takes image input (models.dev `modalities.input`).
    /// Absent when models.dev does not say.
    #[serde(default)]
    img: Option<bool>,
}

/// One snapshot model: its price plus the facts models.dev publishes about it.
struct SnapshotModel {
    price: ModelPrice,
    context_window: Option<u64>,
    image_input: Option<bool>,
}

struct Snapshot {
    fetched_at: String,
    providers: HashMap<String, HashMap<String, SnapshotModel>>,
}

fn snapshot() -> &'static Snapshot {
    static SNAPSHOT: OnceLock<Snapshot> = OnceLock::new();
    SNAPSHOT.get_or_init(|| {
        // The file is generated and covered by tests; a parse failure here would
        // be a build-time mistake, so it degrades to "no snapshot" rather than
        // taking the app down.
        let file: SnapshotFile = match serde_json::from_str(SNAPSHOT_JSON) {
            Ok(file) => file,
            Err(_) => {
                return Snapshot {
                    fetched_at: String::new(),
                    providers: HashMap::new(),
                }
            }
        };
        let providers = file
            .providers
            .into_iter()
            .map(|(provider, models)| {
                let models = models
                    .into_iter()
                    .map(|(id, e)| {
                        (
                            id,
                            SnapshotModel {
                                price: ModelPrice {
                                    input_per_mtok: e.i,
                                    output_per_mtok: e.o,
                                    cache_read_per_mtok: e.cr,
                                    cache_write_per_mtok: e.cw,
                                },
                                context_window: e.c.filter(|&c| c > 0),
                                image_input: e.img,
                            },
                        )
                    })
                    .collect();
                (provider, models)
            })
            .collect();
        Snapshot {
            fetched_at: file.fetched_at,
            providers,
        }
    })
}

/// The date (`YYYY-MM-DD`) the bundled snapshot was fetched from models.dev.
pub fn snapshot_fetched_at() -> &'static str {
    &snapshot().fetched_at
}

/// Ids worth trying for a model, most specific first: the id as given, without
/// a `models/` prefix, and without a trailing release date
/// (`claude-sonnet-4-20250514`, `gpt-4o-2024-08-06`).
fn candidate_ids(model_id: &str) -> Vec<String> {
    let mut out = vec![model_id.to_string()];
    let bare = model_id.strip_prefix("models/").unwrap_or(model_id);
    if bare != model_id {
        out.push(bare.to_string());
    }
    if let Some(undated) = strip_date_suffix(bare) {
        out.push(undated.to_string());
    }
    out
}

fn strip_date_suffix(id: &str) -> Option<&str> {
    let bytes = id.as_bytes();
    // -YYYYMMDD
    if bytes.len() > 9 && bytes[bytes.len() - 9] == b'-' {
        let tail = &id[id.len() - 8..];
        if tail.bytes().all(|b| b.is_ascii_digit()) && tail.starts_with("20") {
            return Some(&id[..id.len() - 9]);
        }
    }
    // -YYYY-MM-DD
    if bytes.len() > 11 && bytes[bytes.len() - 11] == b'-' {
        let tail = &id[id.len() - 10..];
        let shape = tail.bytes().enumerate().all(|(i, b)| match i {
            4 | 7 => b == b'-',
            _ => b.is_ascii_digit(),
        });
        if shape && tail.starts_with("20") {
            return Some(&id[..id.len() - 11]);
        }
    }
    None
}

fn snapshot_model(provider_id: &str, model_id: &str) -> Option<&'static SnapshotModel> {
    let models = snapshot().providers.get(provider_id)?;
    let candidates = candidate_ids(model_id);
    for candidate in &candidates {
        if let Some(model) = models.get(candidate) {
            return Some(model);
        }
    }
    // Ids are case-sensitive on the wire, but a listing and the catalog can
    // disagree on case (Together's `Qwen/…`), and a case-only difference never
    // names a different model.
    for candidate in &candidates {
        if let Some((_, model)) = models
            .iter()
            .find(|(id, _)| id.eq_ignore_ascii_case(candidate))
        {
            return Some(model);
        }
    }
    None
}

fn snapshot_price(provider_id: &str, model_id: &str) -> Option<ModelPrice> {
    snapshot_model(provider_id, model_id).map(|m| m.price)
}

/// The model's context window in tokens per the bundled models.dev snapshot,
/// or `None` when the snapshot does not know the model or its window.
pub fn snapshot_context_window(provider_id: &str, model_id: &str) -> Option<u64> {
    snapshot_model(provider_id, model_id)?.context_window
}

/// Whether the model takes image input per the bundled models.dev snapshot:
/// `None` when the snapshot does not know the model or its input modalities.
pub fn snapshot_accepts_images(provider_id: &str, model_id: &str) -> Option<bool> {
    snapshot_model(provider_id, model_id)?.image_input
}

fn retired_price(provider_id: &str, model_id: &str) -> Option<ModelPrice> {
    candidate_ids(model_id).iter().find_map(|candidate| {
        RETIRED
            .iter()
            .find(|(p, m, ..)| *p == provider_id && *m == candidate.as_str())
            .map(
                |&(_, _, input, output, cache_read, cache_write)| ModelPrice {
                    input_per_mtok: input,
                    output_per_mtok: output,
                    cache_read_per_mtok: (cache_read > 0.0).then_some(cache_read),
                    cache_write_per_mtok: (cache_write > 0.0).then_some(cache_write),
                },
            )
    })
}

/// Resolve a model's price. `live` is the price the provider reported in its
/// model listing this session, if any. `None` means the model is unpriced.
pub fn resolve_price(
    provider_id: &str,
    model_id: &str,
    overrides: &[ModelPriceOverride],
    live: Option<ModelPrice>,
) -> Option<ResolvedModelPrice> {
    let found = |price, source| Some(ResolvedModelPrice { price, source });

    if let Some(o) = overrides
        .iter()
        .find(|o| o.provider_id == provider_id && o.model_id == model_id)
    {
        return found(o.price, PriceSource::Override);
    }
    if let Some(price) = live {
        return found(price, PriceSource::Provider);
    }
    if let Some(price) = snapshot_price(provider_id, model_id) {
        return found(price, PriceSource::Snapshot);
    }
    if let Some(price) = retired_price(provider_id, model_id) {
        return found(price, PriceSource::Retired);
    }
    if LOCAL_PROVIDERS.contains(&provider_id) {
        return found(
            ModelPrice {
                input_per_mtok: 0.0,
                output_per_mtok: 0.0,
                cache_read_per_mtok: None,
                cache_write_per_mtok: None,
            },
            PriceSource::Local,
        );
    }
    None
}

/// Token counts for one priced unit of usage (a turn, or a stored usage row).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TokenCounts {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

/// Whether this provider's reported input count already includes cache reads.
/// True for everything except Anthropic's native Messages API. (OpenCode Zen
/// routes Claude over that API too; its adapter folds cache reads into input so
/// that this per-provider rule holds.) Cache writes are never part of input.
pub fn input_includes_cache_reads(provider_id: &str) -> bool {
    provider_id != "anthropic"
}

/// Estimated cost in USD. Cache tokens without a published cache price are
/// charged at the input price.
pub fn estimate_cost_usd(provider_id: &str, tokens: TokenCounts, price: &ModelPrice) -> f64 {
    let uncached_input = if input_includes_cache_reads(provider_id) {
        tokens.input.saturating_sub(tokens.cache_read)
    } else {
        tokens.input
    };
    let per = |count: u64, rate: f64| count as f64 / 1_000_000.0 * rate;
    per(uncached_input, price.input_per_mtok)
        + per(tokens.output, price.output_per_mtok)
        + per(
            tokens.cache_read,
            price.cache_read_per_mtok.unwrap_or(price.input_per_mtok),
        )
        + per(
            tokens.cache_write,
            price.cache_write_per_mtok.unwrap_or(price.input_per_mtok),
        )
}

/// [`estimate_cost_usd`] in cents, the unit the usage tables and the renderer use.
pub fn estimate_cost_cents(provider_id: &str, tokens: TokenCounts, price: &ModelPrice) -> f64 {
    estimate_cost_usd(provider_id, tokens, price) * 100.0
}

/// Parse OpenRouter's `pricing` object from `/models`: per-token USD amounts as
/// strings (`"0.000003"`). Returns `None` for anything else, including the
/// negative placeholder OpenRouter uses for routers with variable pricing, so a
/// different provider's `pricing` shape is never misread.
pub fn parse_openrouter_pricing(value: &serde_json::Value) -> Option<ModelPrice> {
    let per_mtok = |key: &str| -> Option<f64> {
        let amount: f64 = value.get(key)?.as_str()?.trim().parse().ok()?;
        (amount.is_finite() && amount >= 0.0).then_some(amount * 1_000_000.0)
    };
    Some(ModelPrice {
        input_per_mtok: per_mtok("prompt")?,
        output_per_mtok: per_mtok("completion")?,
        cache_read_per_mtok: per_mtok("input_cache_read"),
        cache_write_per_mtok: per_mtok("input_cache_write"),
    })
}

/// Bounds a user-entered price must sit inside: finite, not negative, and below
/// a ceiling no real model approaches (a typo guard, not a business rule).
pub const MAX_PRICE_PER_MTOK: f64 = 10_000.0;

pub fn price_is_valid(price: &ModelPrice) -> bool {
    let ok = |v: f64| v.is_finite() && (0.0..=MAX_PRICE_PER_MTOK).contains(&v);
    ok(price.input_per_mtok)
        && ok(price.output_per_mtok)
        && price.cache_read_per_mtok.is_none_or(ok)
        && price.cache_write_per_mtok.is_none_or(ok)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn price(i: f64, o: f64) -> ModelPrice {
        ModelPrice {
            input_per_mtok: i,
            output_per_mtok: o,
            cache_read_per_mtok: None,
            cache_write_per_mtok: None,
        }
    }

    #[test]
    fn snapshot_parses_and_is_dated() {
        assert!(!snapshot().providers.is_empty(), "snapshot failed to parse");
        assert_eq!(snapshot_fetched_at().len(), 10);
    }

    #[test]
    fn snapshot_covers_every_priced_cloud_provider() {
        // Every cloud provider in the registry except the generic
        // OpenAI-compatible one must have snapshot entries, or its usage would
        // silently be unpriced.
        for descriptor in crate::catalog::list_descriptors() {
            let id = descriptor.id;
            if LOCAL_PROVIDERS.contains(&id) || id == "openai_compat" {
                continue;
            }
            let count = snapshot().providers.get(id).map_or(0, HashMap::len);
            assert!(count > 0, "no snapshot prices for provider {id}");
        }
    }

    #[test]
    fn flagship_models_resolve_from_the_snapshot() {
        for (provider, model) in [
            ("anthropic", "claude-sonnet-4-5"),
            ("openai", "gpt-4o"),
            ("gemini", "gemini-2.5-pro"),
        ] {
            let resolved = resolve_price(provider, model, &[], None)
                .unwrap_or_else(|| panic!("{provider}/{model} is unpriced"));
            assert_eq!(resolved.source, PriceSource::Snapshot);
            assert!(resolved.price.output_per_mtok > resolved.price.input_per_mtok);
        }
    }

    #[test]
    fn deepseek_context_windows_come_from_the_snapshot() {
        // models.dev lists every current DeepSeek API model at 1M tokens.
        for model in ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-flash"] {
            assert_eq!(
                snapshot_context_window("deepseek", model),
                Some(1_000_000),
                "{model}"
            );
        }
        // OpenRouter's own listing of the same family reports 1,048,576.
        assert_eq!(
            snapshot_context_window("openrouter", "deepseek/deepseek-v4-pro"),
            Some(1_048_576)
        );
        // Unknown model, unknown provider: no guess.
        assert_eq!(snapshot_context_window("deepseek", "deepseek-nope"), None);
        assert_eq!(snapshot_context_window("nope", "deepseek-v4-pro"), None);
    }

    #[test]
    fn image_input_comes_from_the_snapshot() {
        assert_eq!(
            snapshot_accepts_images("deepseek", "deepseek-v4-flash"),
            Some(true)
        );
        assert_eq!(
            snapshot_accepts_images("deepseek", "deepseek-v4-pro"),
            Some(false)
        );
        assert_eq!(snapshot_accepts_images("deepseek", "deepseek-nope"), None);
    }

    #[test]
    fn dated_and_prefixed_ids_fall_back_to_the_bare_id() {
        assert_eq!(
            candidate_ids("claude-sonnet-4-20250514"),
            vec!["claude-sonnet-4-20250514", "claude-sonnet-4"]
        );
        assert_eq!(
            candidate_ids("models/gemini-2.5-pro"),
            vec!["models/gemini-2.5-pro", "gemini-2.5-pro"]
        );
        assert_eq!(
            candidate_ids("gpt-4o-2099-01-01"),
            vec!["gpt-4o-2099-01-01", "gpt-4o"]
        );
        assert_eq!(candidate_ids("glm-5.3"), vec!["glm-5.3"]);
        // A four-digit model number is not a date.
        assert_eq!(candidate_ids("model-1234"), vec!["model-1234"]);
    }

    #[test]
    fn retired_models_keep_a_price() {
        let resolved = resolve_price("anthropic", "claude-sonnet-4-20250514", &[], None).unwrap();
        assert!(matches!(
            resolved.source,
            PriceSource::Snapshot | PriceSource::Retired
        ));
        assert_eq!(resolved.price.input_per_mtok, 3.0);
    }

    #[test]
    fn override_beats_live_beats_snapshot() {
        let overrides = vec![ModelPriceOverride {
            provider_id: "openai".into(),
            model_id: "gpt-4o".into(),
            price: price(1.0, 2.0),
        }];
        let live = Some(price(7.0, 8.0));
        let r = resolve_price("openai", "gpt-4o", &overrides, live).unwrap();
        assert_eq!(
            (r.source, r.price.input_per_mtok),
            (PriceSource::Override, 1.0)
        );
        let r = resolve_price("openai", "gpt-4o", &[], live).unwrap();
        assert_eq!(
            (r.source, r.price.input_per_mtok),
            (PriceSource::Provider, 7.0)
        );
        // An override for another provider's model of the same name does not apply.
        let r = resolve_price("openrouter", "gpt-4o", &overrides, None);
        assert_ne!(r.map(|r| r.source), Some(PriceSource::Override));
    }

    #[test]
    fn local_is_free_and_unknown_is_unpriced() {
        let r = resolve_price("ollama", "llama3:8b", &[], None).unwrap();
        assert_eq!(r.source, PriceSource::Local);
        assert_eq!(r.price.input_per_mtok, 0.0);
        assert!(resolve_price("openai_compat", "my-model", &[], None).is_none());
        assert!(resolve_price("anthropic", "no-such-model", &[], None).is_none());
    }

    #[test]
    fn cost_is_in_real_units() {
        // 1M input + 1M output at $3 / $15 is $18, i.e. 1,800 cents.
        let p = price(3.0, 15.0);
        let tokens = TokenCounts {
            input: 1_000_000,
            output: 1_000_000,
            ..Default::default()
        };
        assert!((estimate_cost_usd("anthropic", tokens, &p) - 18.0).abs() < 1e-9);
        assert!((estimate_cost_cents("anthropic", tokens, &p) - 1800.0).abs() < 1e-6);
    }

    #[test]
    fn cache_reads_are_not_billed_twice() {
        let p = ModelPrice {
            input_per_mtok: 2.0,
            output_per_mtok: 10.0,
            cache_read_per_mtok: Some(0.2),
            cache_write_per_mtok: Some(2.5),
        };
        // OpenAI-style: 1M input of which 800k were cache hits.
        let openai = TokenCounts {
            input: 1_000_000,
            cache_read: 800_000,
            ..Default::default()
        };
        // 200k uncached at $2 + 800k cached at $0.20 = $0.40 + $0.16.
        assert!((estimate_cost_usd("openai", openai, &p) - 0.56).abs() < 1e-9);
        // Anthropic reports input excluding cache reads, so nothing is subtracted.
        let anthropic = TokenCounts {
            input: 200_000,
            cache_read: 800_000,
            cache_write: 100_000,
            ..Default::default()
        };
        // $0.40 + $0.16 + 100k writes at $2.50 = $0.81.
        assert!((estimate_cost_usd("anthropic", anthropic, &p) - 0.81).abs() < 1e-9);
    }

    #[test]
    fn anthropic_cached_turn_is_priced_at_cache_rates() {
        // Snapshot prices for Claude carry both cache rates (0.1x read, 1.25x
        // write), so a cached turn is not billed as plain input.
        let p = resolve_price("anthropic", "claude-sonnet-4-5", &[], None)
            .unwrap()
            .price;
        let (read, write) = (
            p.cache_read_per_mtok.expect("snapshot cache read price"),
            p.cache_write_per_mtok.expect("snapshot cache write price"),
        );
        assert!(read < p.input_per_mtok && write > p.input_per_mtok);
        // As Anthropic reports it: 50 uncached input tokens on top of a 90k
        // cached prefix, 10k of it newly written this turn.
        let tokens = TokenCounts {
            input: 50,
            output: 500,
            cache_read: 80_000,
            cache_write: 10_000,
        };
        let expected = (50.0 * p.input_per_mtok
            + 500.0 * p.output_per_mtok
            + 80_000.0 * read
            + 10_000.0 * write)
            / 1_000_000.0;
        assert!((estimate_cost_usd("anthropic", tokens, &p) - expected).abs() < 1e-12);
        // Far cheaper than the same 90,050 input tokens uncached.
        let uncached = TokenCounts {
            input: 90_050,
            output: 500,
            ..Default::default()
        };
        assert!(
            estimate_cost_usd("anthropic", tokens, &p)
                < estimate_cost_usd("anthropic", uncached, &p) / 2.0
        );
    }

    #[test]
    fn missing_cache_prices_fall_back_to_input() {
        let p = price(1.0, 1.0);
        let tokens = TokenCounts {
            input: 0,
            cache_read: 1_000_000,
            cache_write: 1_000_000,
            ..Default::default()
        };
        assert!((estimate_cost_usd("anthropic", tokens, &p) - 2.0).abs() < 1e-9);
    }

    #[test]
    fn openrouter_pricing_parses_per_token_strings() {
        let v = serde_json::json!({
            "prompt": "0.000003",
            "completion": "0.000015",
            "input_cache_read": "0.0000003",
            "request": "0"
        });
        let p = parse_openrouter_pricing(&v).unwrap();
        assert!((p.input_per_mtok - 3.0).abs() < 1e-9);
        assert!((p.output_per_mtok - 15.0).abs() < 1e-9);
        assert!((p.cache_read_per_mtok.unwrap() - 0.3).abs() < 1e-9);
        assert_eq!(p.cache_write_per_mtok, None);
    }

    #[test]
    fn openrouter_pricing_rejects_placeholders_and_other_shapes() {
        // Variable-price routers report -1.
        assert!(
            parse_openrouter_pricing(&serde_json::json!({"prompt": "-1", "completion": "-1"}))
                .is_none()
        );
        // Together's numeric per-Mtok shape must not be misread as per-token.
        assert!(
            parse_openrouter_pricing(&serde_json::json!({"input": 0.88, "output": 0.88})).is_none()
        );
        assert!(
            parse_openrouter_pricing(&serde_json::json!({"prompt": 3, "completion": 15})).is_none()
        );
    }

    #[test]
    fn user_prices_are_bounded() {
        assert!(price_is_valid(&price(0.0, 75.0)));
        assert!(!price_is_valid(&price(-1.0, 1.0)));
        assert!(!price_is_valid(&price(f64::NAN, 1.0)));
        assert!(!price_is_valid(&price(1.0, MAX_PRICE_PER_MTOK + 1.0)));
    }
}
