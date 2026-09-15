import { expect, test, type Page } from '@playwright/test';

/**
 * The MCP picker buttons in the real composer.
 *
 * The gallery spec drives the popovers themselves against fixtures; this one
 * answers the question the gallery cannot — whether the buttons appear in the
 * shell at all, and whether a connector that offers only tools still looks
 * exactly as it did before this feature existed (t0-9 acceptance criterion 7).
 *
 * `dev:web` has no IPC, so `invoke` is stubbed before any page script runs.
 * Only the two list commands answer; everything else rejects, which is what
 * the renderer already sees in `dev:web` today — so boot behaves no differently
 * from the other specs in this directory.
 */

const PROMPTS = [
  {
    connectorVersionId: 'echo:1.0.0',
    connectorName: 'Echo',
    name: 'summarize',
    description: 'Summarize a document',
    arguments: [{ name: 'topic', description: 'What to summarize', required: true }],
    stale: false,
    discoveredAt: '2026-09-15T00:00:00Z',
  },
];

const RESOURCES = [
  {
    connectorVersionId: 'echo:1.0.0',
    connectorName: 'Echo',
    name: 'spec.md',
    uri: 'echo://notes/spec.md',
    description: 'A short spec document',
    stale: false,
    discoveredAt: '2026-09-15T00:00:00Z',
  },
];

/**
 * Stub the Tauri bridge. `@tauri-apps/api` v2 funnels every call through
 * `window.__TAURI_INTERNALS__.invoke`, so replacing that object is enough —
 * no module mocking, and the renderer is exercised unmodified.
 */
async function stubIpc(
  page: Page,
  answers: { prompts: unknown[]; resources: unknown[] },
) {
  await page.addInitScript((data) => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: (cmd: string) => {
        if (cmd === 'list_connector_prompts') return Promise.resolve(data.prompts);
        if (cmd === 'list_connector_resources') return Promise.resolve(data.resources);
        // Everything else fails exactly as it does in dev:web today.
        return Promise.reject('no IPC in dev:web');
      },
      transformCallback: (cb: unknown) => cb,
      unregisterCallback: () => {},
      convertFileSrc: (p: string) => p,
    };
  }, answers);
}

async function openShell(page: Page) {
  await page.goto('/?locale=en');
  // The composer is the last thing the empty shell renders.
  await page.waitForSelector('.composer-textarea', { timeout: 30_000 });
}

test.describe('a connector that offers prompts and resources', () => {
  test('puts both picker buttons in the composer', async ({ page }) => {
    await stubIpc(page, { prompts: PROMPTS, resources: RESOURCES });
    await openShell(page);

    await expect(page.getByRole('button', { name: 'MCP prompts' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'MCP resources' })).toBeVisible();
  });

  test('opens the prompt picker and lists the server it came from', async ({ page }) => {
    await stubIpc(page, { prompts: PROMPTS, resources: RESOURCES });
    await openShell(page);

    await page.getByRole('button', { name: 'MCP prompts' }).click();
    const pop = page.getByRole('dialog', { name: 'MCP prompts' });
    await expect(pop).toBeVisible();
    // The row's accessible name is the prompt name plus its description, so
    // match the button rather than the text: 'summarize' alone also matches
    // the description beneath it.
    await expect(pop.getByRole('button', { name: 'summarize Summarize a document' })).toBeVisible();
    await expect(pop.getByText('Echo', { exact: true })).toBeVisible();
  });

  test('opens the resource picker with the resource detached', async ({ page }) => {
    await stubIpc(page, { prompts: PROMPTS, resources: RESOURCES });
    await openShell(page);

    await page.getByRole('button', { name: 'MCP resources' }).click();
    const pop = page.getByRole('dialog', { name: 'MCP resources' });
    await expect(pop).toBeVisible();
    await expect(pop.getByRole('switch').first()).toHaveAttribute('aria-pressed', 'false');
  });

  test('only one picker is open at a time', async ({ page }) => {
    await stubIpc(page, { prompts: PROMPTS, resources: RESOURCES });
    await openShell(page);

    await page.getByRole('button', { name: 'MCP prompts' }).click();
    await expect(page.getByRole('dialog', { name: 'MCP prompts' })).toBeVisible();
    await page.getByRole('button', { name: 'MCP resources' }).click();
    await expect(page.getByRole('dialog', { name: 'MCP resources' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'MCP prompts' })).toBeHidden();
  });
});

test.describe('a connector that offers only tools', () => {
  // Acceptance criterion 7: nothing about the composer changes for someone
  // whose servers advertise no prompts and no resources.
  test('adds no buttons to the composer', async ({ page }) => {
    await stubIpc(page, { prompts: [], resources: [] });
    await openShell(page);

    await expect(page.getByRole('button', { name: 'MCP prompts' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'MCP resources' })).toHaveCount(0);
  });
});
