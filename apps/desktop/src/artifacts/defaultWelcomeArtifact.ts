import type { Artifact } from '../ipc/contracts';
import {
  buildWelcomePromptCardsHtml,
  STARTER_SUGGESTED_PROMPTS,
} from '../chat/suggestedPromptData';

/** Stable synthetic id for the built-in welcome artifact (never persisted). */
export const WELCOME_ARTIFACT_ID = '__welcome__';

/// HTML body fragment for the welcome artifact. Kept inline so the preview is a
/// normal sandboxed HTML artifact, not a special-case React empty state.
export const WELCOME_ARTIFACT_HTML = `<style>
  html { color-scheme: light; }
  html[data-theme="dark"] { color-scheme: dark; }

  :root {
    --ink: #15181b;
    --muted: #59616a;
    --border: #e4e7ea;
    --card-bg: #ffffff;
    --card-hover: #f8f9fa;
    --accent: #0d9488;
    --accent-soft: rgba(13, 148, 136, 0.12);
    --icon-bg: rgba(13, 148, 136, 0.1);
    --page-bg: linear-gradient(180deg, #f5f6f7 0%, #fbfbfc 100%);
  }

  html[data-theme="dark"] {
    --ink: #e9ebed;
    --muted: #969da4;
    --border: #24282d;
    --card-bg: #131517;
    --card-hover: #191c1f;
    --accent: #5eead4;
    --accent-soft: rgba(45, 212, 191, 0.14);
    --icon-bg: rgba(45, 212, 191, 0.1);
    --page-bg: linear-gradient(180deg, #0c0d0f 0%, #101214 100%);
  }

  * { box-sizing: border-box; }

  body {
    background: var(--page-bg);
    color: var(--ink);
    margin: 0;
    min-height: 100vh;
  }

  .welcome {
    align-items: center;
    display: flex;
    flex-direction: column;
    justify-content: center;
    margin: 0 auto;
    max-width: 560px;
    min-height: 100vh;
    padding: 32px 20px;
    text-align: center;
  }

  .app-icon {
    align-items: center;
    background: var(--icon-bg);
    border: 1px solid var(--border);
    border-radius: 18px;
    color: var(--accent);
    display: inline-flex;
    height: 56px;
    justify-content: center;
    margin-bottom: 16px;
    width: 56px;
  }

  .app-icon svg {
    height: 30px;
    width: 30px;
  }

  h1 {
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1.2;
    margin: 0 0 8px;
  }

  .subtitle {
    color: var(--muted);
    font-size: 13.5px;
    line-height: 1.5;
    margin: 0 0 24px;
    max-width: 420px;
  }

  .prompts {
    display: grid;
    gap: 8px;
    text-align: left;
    width: 100%;
  }

  .prompt-card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 12px 14px;
    transition: background 0.15s ease;
  }

  .prompt-card:hover {
    background: var(--card-hover);
  }

  .prompt-label {
    color: var(--accent);
    display: block;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.08em;
    margin-bottom: 4px;
    text-transform: uppercase;
  }

  .prompt-text {
    color: var(--ink);
    font-size: 13px;
    line-height: 1.45;
    margin: 0;
  }
</style>

<main class="welcome">
  <div class="app-icon" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="3.1" fill="currentColor"></circle>
      <g stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
        <path d="M12 9V3.6"></path>
        <path d="M14.6 13.5l3.8 3.8"></path>
        <path d="M9.4 13.5l-3.8 3.8"></path>
      </g>
      <circle cx="12" cy="3.2" r="1.7" fill="currentColor"></circle>
      <circle cx="18.8" cy="17.7" r="1.7" fill="currentColor" opacity="0.6"></circle>
      <circle cx="5.2" cy="17.7" r="1.7" fill="currentColor" opacity="0.6"></circle>
    </svg>
  </div>

  <h1>Welcome to Conduit</h1>
  <p class="subtitle">Start a chat, ask for something useful, then promote the result here as an artifact.</p>

  <div class="prompts" aria-label="Example prompts">
${buildWelcomePromptCardsHtml(STARTER_SUGGESTED_PROMPTS)}
  </div>
</main>`;

export function isWelcomeArtifact(artifact: Artifact | null | undefined): boolean {
  return artifact?.id === WELCOME_ARTIFACT_ID;
}

export const DEFAULT_WELCOME_ARTIFACT: Artifact = {
  id: WELCOME_ARTIFACT_ID,
  conversationId: '',
  kind: 'html',
  title: 'Welcome',
  createdAt: '1970-01-01T00:00:00Z',
  mimeType: 'text/html',
  contentText: WELCOME_ARTIFACT_HTML,
  metadata: { virtual: true },
};
