import { describe, expect, it } from 'vitest';
import { matchesModel, matchesProvider, queryTerms, sortModels } from './modelOrder';

describe('sortModels', () => {
  it('orders by the shown label, case-insensitively and numerically', () => {
    const sorted = sortModels([
      { id: 'gpt-10' },
      { id: 'b', displayName: 'beta' },
      { id: 'GPT-4' },
      { id: 'qwen3:14b' },
      { id: 'a', displayName: 'Alpha' },
      { id: 'qwen3:8b' },
    ] as never);
    expect(sorted.map((m) => m.displayName ?? m.id)).toEqual([
      'Alpha',
      'beta',
      'GPT-4',
      'gpt-10',
      'qwen3:8b',
      'qwen3:14b',
    ]);
  });

  it('leaves the input untouched', () => {
    const models = [{ id: 'b' }, { id: 'a' }] as never[];
    sortModels(models);
    expect(models).toEqual([{ id: 'b' }, { id: 'a' }]);
  });
});

describe('matchesModel', () => {
  const llama = { id: 'meta-llama/llama-3.3-70b', displayName: 'Llama 3.3 70B' } as never;
  const qwen = { id: 'qwen3:8b' } as never;

  it('matches every term, in any order, against model or provider', () => {
    const terms = queryTerms('  LLAMA   open ');
    expect(terms).toEqual(['llama', 'open']);
    expect(matchesModel(terms, 'OpenRouter', llama)).toBe(true);
    expect(matchesModel(terms, 'Groq', llama)).toBe(false);
  });

  it('does not let a model family match inside a provider name', () => {
    // "llama" is inside "Ollama"; every Ollama model must not match it.
    expect(matchesModel(['llama'], 'Ollama', qwen)).toBe(false);
    expect(matchesModel(['olla'], 'Ollama', qwen)).toBe(true);
  });

  it('matches everything for a blank query', () => {
    expect(matchesModel(queryTerms('   '), 'Ollama', qwen)).toBe(true);
  });
});

describe('matchesProvider', () => {
  it('matches the start of any word', () => {
    expect(matchesProvider('studio', 'LM Studio')).toBe(true);
    expect(matchesProvider('tudio', 'LM Studio')).toBe(false);
  });
});
