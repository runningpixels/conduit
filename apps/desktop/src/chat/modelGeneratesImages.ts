/** Mirror of provider-core `model_generates_images` for UI gating (t0-8). */
export function modelGeneratesImages(providerId: string, modelId: string): boolean {
  const provider = providerId.trim().toLowerCase();
  const model = modelId.trim().toLowerCase();

  switch (provider) {
    case 'openai':
      return model.includes('dall-e') || model.includes('gpt-image');
    case 'gemini':
      return model.includes('imagen');
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
    default:
      return null;
  }
}
