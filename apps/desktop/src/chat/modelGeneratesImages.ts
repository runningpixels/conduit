/** Mirror of provider-core `model_generates_images` for UI gating (t0-8). */
export function modelGeneratesImages(providerId: string, modelId: string): boolean {
  const provider = providerId.trim().toLowerCase();
  const model = modelId.trim().toLowerCase();

  switch (provider) {
    case 'openai':
      return model.includes('dall-e') || model.includes('gpt-image');
    case 'gemini':
      return model.includes('imagen');
    // OpenRouter fans out to many vendors under a `vendor/model` namespace,
    // so this is the loosest of the three -- it recognises the naming
    // patterns actually seen in OpenRouter's image-model catalog rather than
    // trying to be exhaustive. An unrecognised image model simply is not
    // picked up, the same narrow tradeoff the other two already accept.
    case 'openrouter':
      return (
        model.includes('image') ||
        model.includes('imagen') ||
        model.includes('dall-e') ||
        model.includes('seedream') ||
        model.includes('flux') ||
        model.includes('recraft')
      );
    default:
      return false;
  }
}

/**
 * Mirror of provider-core `default_image_model` (`image_generation.rs`) for
 * UI gating (t0-8 M4).
 *
 * The turn's active *chat* model is never an image model, so gating
 * `generate_image`'s visibility on `modelGeneratesImages(activeProvider,
 * activeModel)` would be false for every real user -- see the Rust
 * function's doc comment. Gating on the provider and using this hardcoded
 * per-provider default instead is the deliberate M3/M4 tradeoff.
 */
export function defaultImageModel(providerId: string): string | null {
  switch (providerId.trim().toLowerCase()) {
    case 'openai':
      return 'gpt-image-2.5-sunburst';
    case 'gemini':
      return 'imagen-4.0-generate-001';
    // The same OpenAI image model this app already defaults to, reached
    // through OpenRouter's vendor namespace -- deliberately not picking some
    // third-party vendor on the user's behalf.
    case 'openrouter':
      return 'openai/gpt-image-2.5-sunburst';
    default:
      return null;
  }
}
