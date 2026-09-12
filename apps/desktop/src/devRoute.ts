/**
 * The developer route override.
 *
 * One job: let the layout suite reach a screen it otherwise cannot.
 *
 * `layout/*.spec.ts` drives `pnpm dev:web` — the renderer with no Tauri
 * backend — so every IPC call rejects. `App`'s boot catches that, never sets
 * `onboarding`, and falls through to the workspace. The result is that the
 * first-run screen has never been measured by the suite that exists to catch
 * length-sensitive layout, which is exactly the screen where a five-item
 * stepper and a two-column card meet seven translations.
 *
 * Modelled on `i18n/devLocale.ts`, including the reason it is safe:
 * `import.meta.env.DEV` is a Vite `define`, so in a production build the body
 * below is dead code the minifier drops and a packaged app cannot reach it.
 * `devRoute.test.ts` pins that it is inert without the flag.
 *
 * Deliberately NOT persisted, unlike the locale override. A stuck locale is a
 * curiosity; a stuck route would hide the real app behind a screen with no way
 * out, and the only way back would be to know about a query parameter you
 * cannot see. It lives for exactly one page load.
 *
 *   ?route=onboarding    render the first-run wizard against default settings
 */

export type DevRoute = 'onboarding' | null;

const KNOWN: readonly string[] = ['onboarding'];

export function readDevRoute(search?: string): DevRoute {
  if (!import.meta.env.DEV) return null;
  try {
    const raw = new URLSearchParams(search ?? window.location.search).get('route');
    if (raw && KNOWN.includes(raw)) return raw as DevRoute;
  } catch {
    /* No window, or a blocked location — behave as if unset. */
  }
  return null;
}
