import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_FORM_SUBMIT_SCRIPT } from './formSubmit';

// The script installs document-level listeners; install once for the file.
new Function(ARTIFACT_FORM_SUBMIT_SCRIPT)();

function form(html: string) {
  const f = document.createElement('form');
  f.innerHTML = html;
  document.body.appendChild(f);
  const onSubmit = vi.fn((e: Event) => e.preventDefault());
  f.addEventListener('submit', onSubmit);
  return { f, onSubmit };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('artifact form submit script', () => {
  it('turns a submit button click into one submit event', () => {
    const { f, onSubmit } = form('<input name="q"><button>Go</button>');
    f.querySelector('button')!.click();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0].cancelable).toBe(true);
  });

  it('leaves type="button" buttons alone', () => {
    const { f, onSubmit } = form('<input name="q"><button type="button">Clear</button>');
    f.querySelector('button')!.click();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits on Enter in a form without a submit button', () => {
    const { f, onSubmit } = form('<input name="q">');
    f.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('respects validation and requestSubmit()', () => {
    const { f, onSubmit } = form('<input name="q" required><button>Go</button>');
    f.querySelector('button')!.click();
    expect(onSubmit).not.toHaveBeenCalled();
    f.querySelector('input')!.value = 'torvalds';
    f.requestSubmit();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
