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
