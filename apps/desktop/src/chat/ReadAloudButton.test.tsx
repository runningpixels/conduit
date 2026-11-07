import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReadAloudButton } from './ReadAloudButton';
import { resetReadAloudForTests } from '../lib/readAloud';

function stubSpeech(langs: string[]) {
  const synth = {
    getVoices: () => langs.map((lang) => ({ lang, name: lang, default: false, localService: true, voiceURI: lang })),
    speak: vi.fn(),
    cancel: vi.fn(),
    addEventListener: vi.fn(),
  };
  vi.stubGlobal('speechSynthesis', synth);
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      text: string;
      voice = null;
      lang = '';
      constructor(text: string) {
        this.text = text;
      }
    },
  );
  return synth;
}

describe('ReadAloudButton', () => {
  afterEach(() => {
    cleanup();
    resetReadAloudForTests();
    vi.unstubAllGlobals();
  });

  it('renders nothing without a speech engine', () => {
    const { container } = render(<ReadAloudButton id="m1" text="Hello there." />);
    expect(container).toBeEmptyDOMElement();
  });

  it('reads the reply, then offers Stop while it speaks', () => {
    const synth = stubSpeech(['en-US']);
    render(<ReadAloudButton id="m1" text="The answer is that it works." />);
    fireEvent.click(screen.getByRole('button', { name: 'Read this reply aloud' }));
    expect(synth.speak).toHaveBeenCalledTimes(1);

    const stop = screen.getByRole('button', { name: 'Stop reading aloud' });
    act(() => {
      fireEvent.click(stop);
    });
    expect(synth.cancel).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Read this reply aloud' })).toBeInTheDocument();
  });

  it('is disabled with the reason when no voice speaks the language', () => {
    stubSpeech(['en-US']);
    render(<ReadAloudButton id="m1" text="Die Antwort ist, dass es nicht mit der Hand geht." />);
    const button = screen.getByRole('button', { name: /No German voice is installed/ });
    expect(button).toBeDisabled();
  });
});
