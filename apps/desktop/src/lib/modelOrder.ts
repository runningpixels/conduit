/**
 * Model list ordering and filtering, shared by every surface that lists a
 * provider's models.
 *
 * Providers return models in their own order — creation date, internal id,
 * nothing at all — and an aggregator like OpenRouter returns hundreds. Listed
 * as-is, finding one model meant scanning the whole list by eye.
 */

import type { ModelInfo } from '../ipc/contracts';

/**
 * Numeric so `gpt-4` sorts before `gpt-10` and `qwen3:8b` before `qwen3:14b`;
 * base sensitivity so case never splits a family.
 */
const modelCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function modelLabel(model: ModelInfo): string {
  return model.displayName ?? model.id;
}

/** A copy of `models`, alphabetical by what the row shows. */
export function sortModels(models: readonly ModelInfo[]): ModelInfo[] {
  return [...models].sort(
    (a, b) => modelCollator.compare(modelLabel(a), modelLabel(b)) || modelCollator.compare(a.id, b.id),
  );
}

/** Lower-cased, whitespace-split search terms; empty for a blank query. */
export function queryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Whether a term starts one of the provider name's words. A prefix, not a
 * substring: "llama" is a model family, and as a substring it would also hit
 * "Ollama" and pull in every model Ollama serves.
 */
export function matchesProvider(term: string, providerName: string): boolean {
  return providerName
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .some((word) => word.startsWith(term));
}

/**
 * Whether every term matches the model (anywhere in its label or id) or its
 * provider (by word prefix). Terms match independently and in any order, so
 * "open llama" finds `meta-llama/llama-3.3-70b` under OpenRouter.
 */
export function matchesModel(
  terms: readonly string[],
  providerName: string,
  model: ModelInfo,
): boolean {
  const haystack = `${modelLabel(model)} ${model.id}`.toLowerCase();
  return terms.every((term) => haystack.includes(term) || matchesProvider(term, providerName));
}
