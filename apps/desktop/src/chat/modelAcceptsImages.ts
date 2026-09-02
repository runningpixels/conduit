/** Mirror of provider-core `model_accepts_images` for UI warnings (t0-1). */
export function modelAcceptsImages(providerId: string, modelId: string): boolean {
  const provider = providerId.trim().toLowerCase();
  const model = modelId.trim().toLowerCase();

  switch (provider) {
    case 'anthropic':
    case 'openai':
    case 'gemini':
    case 'openrouter':
    case 'opencode_zen':
    case 'groq':
    case 'mistral':
    case 'lmstudio':
    case 'openai_compat':
      return true;
    case 'deepseek':
      return false;
    case 'ollama':
      return modelIdSuggestsVision(model);
    default:
      return modelIdSuggestsVision(model);
  }
}

function modelIdSuggestsVision(model: string): boolean {
  const needles = [
    'vision',
    'llava',
    'minicpm',
    'pixtral',
    'gpt-4o',
    'gpt-4.1',
    'claude-3',
    'claude-sonnet',
    'claude-opus',
    'claude-haiku',
    'gemini',
    'qwen2-vl',
    'qwen2.5-vl',
    'qwen3-vl',
    'qwen-vl',
  ];
  return (
    needles.some((n) => model.includes(n)) ||
    model.includes('vl-') ||
    model.endsWith('-vl') ||
    model.includes('vl.')
  );
}
