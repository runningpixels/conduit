import { describe, expect, it } from 'vitest';
import { looksLikeImageGenerationRequest } from './imageGenerationPrompt';

describe('looksLikeImageGenerationRequest: clear generation requests fire', () => {
  it('fires on generate/create/make + an image-product noun', () => {
    expect(looksLikeImageGenerationRequest('generate an image of a mountain sunset')).toBe(true);
    expect(looksLikeImageGenerationRequest('create a picture of a golden retriever')).toBe(true);
    expect(looksLikeImageGenerationRequest('make me a logo for my startup')).toBe(true);
  });

  it('fires on draw/design/paint/sketch/illustrate + an image-product noun', () => {
    expect(looksLikeImageGenerationRequest('draw a picture of a cat wearing a hat')).toBe(true);
    expect(looksLikeImageGenerationRequest('design an icon for the settings menu')).toBe(true);
    expect(looksLikeImageGenerationRequest('paint an illustration of a spaceship')).toBe(true);
    expect(looksLikeImageGenerationRequest('sketch an avatar for my profile')).toBe(true);
    expect(looksLikeImageGenerationRequest('illustrate a graphic of the water cycle')).toBe(true);
  });

  it('fires on a real request phrased as a question, with a concrete object', () => {
    expect(
      looksLikeImageGenerationRequest('Can you generate an image of a mountain sunset for the intro slide?'),
    ).toBe(true);
    expect(looksLikeImageGenerationRequest('could you draw a logo for my bakery please')).toBe(true);
  });

  it('is case-insensitive and tolerant of surrounding punctuation', () => {
    expect(looksLikeImageGenerationRequest('GENERATE AN IMAGE OF A ROBOT.')).toBe(true);
    expect(looksLikeImageGenerationRequest('  make a poster for the concert  ')).toBe(true);
  });
});

describe('looksLikeImageGenerationRequest: capability/support questions do NOT fire', () => {
  it('bare "can you generate images?" style questions are false', () => {
    expect(looksLikeImageGenerationRequest('can you generate images?')).toBe(false);
    expect(looksLikeImageGenerationRequest('Can you generate images')).toBe(false);
    expect(looksLikeImageGenerationRequest('do you support making pictures?')).toBe(false);
    expect(looksLikeImageGenerationRequest('are you able to draw logos for me?')).toBe(false);
    expect(looksLikeImageGenerationRequest('can you make images at all?')).toBe(false);
  });

  it('wh-prefixed capability questions are false', () => {
    expect(looksLikeImageGenerationRequest('what image formats do you support?')).toBe(false);
    expect(looksLikeImageGenerationRequest('which image formats can you output?')).toBe(false);
    expect(looksLikeImageGenerationRequest('how do you generate images?')).toBe(false);
  });

  it('format/support questions without a wh-prefix are false', () => {
    expect(looksLikeImageGenerationRequest('do you support other image formats?')).toBe(false);
  });

  it('tell me about / explain are informational regardless of image vocabulary', () => {
    expect(looksLikeImageGenerationRequest('tell me about image generation')).toBe(false);
    expect(looksLikeImageGenerationRequest('explain how image generation works')).toBe(false);
  });
});

describe('looksLikeImageGenerationRequest: requests to read an existing image do NOT fire', () => {
  it('reading/describing/analyzing verbs paired with an image noun are false', () => {
    expect(looksLikeImageGenerationRequest('describe this photo')).toBe(false);
    expect(looksLikeImageGenerationRequest('what is in this image?')).toBe(false);
    expect(looksLikeImageGenerationRequest("what's in this image?")).toBe(false);
    expect(looksLikeImageGenerationRequest('analyze the attached image and summarize it')).toBe(false);
    expect(looksLikeImageGenerationRequest('can you identify the objects in this picture?')).toBe(false);
    expect(looksLikeImageGenerationRequest('read this screenshot and tell me what it says')).toBe(false);
    expect(looksLikeImageGenerationRequest('caption this photo')).toBe(false);
  });
});

describe('looksLikeImageGenerationRequest: unrelated prompts do NOT fire', () => {
  it('plain unrelated requests and empty input are false', () => {
    expect(looksLikeImageGenerationRequest('what is the capital of France?')).toBe(false);
    expect(looksLikeImageGenerationRequest('write a poem about autumn')).toBe(false);
    expect(looksLikeImageGenerationRequest('create a table comparing the two plans')).toBe(false);
    expect(looksLikeImageGenerationRequest('')).toBe(false);
    expect(looksLikeImageGenerationRequest('   ')).toBe(false);
  });

  it('a creation verb with no image-product noun is false', () => {
    expect(looksLikeImageGenerationRequest('draw up a project plan for next quarter')).toBe(false);
    expect(looksLikeImageGenerationRequest('make a reservation for two at 8pm')).toBe(false);
  });
});
