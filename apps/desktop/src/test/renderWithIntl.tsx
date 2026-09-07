import type { ReactElement } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { I18nProvider, loadMessages } from '../i18n';

/**
 * Render a component in a specific language.
 *
 * Most tests do not need this. `useT()` falls back to a module-level English
 * `IntlShape` when nothing provides one (see `src/i18n/index.tsx`), so a plain
 * `render(<Thing />)` already renders correct English — which is why
 * extracting `Onboarding.tsx` cost zero edits to the tests that cover it, and
 * why this helper is a convenience rather than a requirement.
 *
 * What it is for is the other case: asserting that a screen is *translated*.
 *
 * It awaits the catalog before rendering, so the component paints in the
 * target language on its first frame and assertions need no `waitFor`. Doing
 * it the other way — letting `I18nProvider` load the catalog itself — leaves a
 * frame of English, and a test written against that frame passes whether or
 * not the translation ever arrives, which makes it worse than no test.
 */
export async function renderWithIntl(
  ui: ReactElement,
  { locale = 'en' }: { locale?: string } = {},
): Promise<RenderResult> {
  const messages = await loadMessages(locale);
  return render(
    <I18nProvider initialPreference={locale} initialMessages={messages}>
      {ui}
    </I18nProvider>,
  );
}
