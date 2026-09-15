import { expect, test, type Page } from '@playwright/test';

/**
 * MCP composer pickers — prompts, resources, and their two follow-up dialogs
 * (`src/chat/ComposerMcpPrompts.tsx`, `ComposerMcpResources.tsx`,
 * `McpPromptArgumentsDialog.tsx`, `McpResourceConsentDialog.tsx`), driven for
 * real in a browser against the `mcp` gallery section (`src/dev/Gallery.tsx`,
 * fixtures in `src/dev/galleryFixtures.ts`).
 *
 * `?route=gallery` renders `Gallery` directly — no IPC, no App boot, so
 * (unlike `narrowOverlay.spec.ts`) there is no "Failed to load desktop state"
 * toast to dismiss before interacting.
 */

async function gotoMcp(page: Page) {
  await page.goto('/?route=gallery&section=mcp&locale=en');
  await page.waitForSelector('[data-gallery-section="mcp"]');
}

function promptsDialog(page: Page) {
  return page.getByRole('dialog', { name: 'MCP prompts' });
}

function resourcesDialog(page: Page) {
  return page.getByRole('dialog', { name: 'MCP resources' });
}

test.beforeEach(async ({ page }) => gotoMcp(page));

test('a resource toggle flips aria-pressed and attaching then detaching returns to the original state', async ({ page }) => {
  const dialog = resourcesDialog(page);
  const attach = dialog.getByRole('switch', { name: 'Attach README.md' });
  await expect(attach).toHaveAttribute('aria-pressed', 'false');

  await attach.click();
  const detach = dialog.getByRole('switch', { name: 'Detach README.md' });
  await expect(detach).toHaveAttribute('aria-pressed', 'true');

  await detach.click();
  await expect(dialog.getByRole('switch', { name: 'Attach README.md' })).toHaveAttribute('aria-pressed', 'false');
});

test('a stale resource cannot be toggled and offers Refresh', async ({ page }) => {
  const dialog = resourcesDialog(page);
  await expect(dialog.getByRole('switch', { name: 'Attach Old export' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Refresh' })).toBeVisible();
});

test('a stale prompt is not pickable and offers Refresh', async ({ page }) => {
  const dialog = promptsDialog(page);
  await expect(dialog.getByRole('button', { name: 'triage_backlog' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Refresh' })).toBeVisible();
});

test('picking a prompt with no arguments reports the pick immediately', async ({ page }) => {
  await promptsDialog(page).getByRole('button', { name: 'list_open_issues' }).click();
  await expect(page.getByTestId('mcp-picked')).toHaveText('list_open_issues');
  await expect(page.getByRole('dialog', { name: /^Arguments for/ })).toHaveCount(0);
});

test('picking a prompt with arguments opens the argument dialog; confirming reports only the filled values', async ({ page }) => {
  await promptsDialog(page).getByRole('button', { name: 'summarize_pr' }).click();

  const dialog = page.getByRole('dialog', { name: 'Arguments for summarize_pr' });
  const confirm = dialog.getByRole('button', { name: 'Insert' });
  await expect(confirm).toBeDisabled();

  await dialog.getByPlaceholder('Value for pr_number').fill('42');
  await expect(confirm).toBeEnabled();

  await confirm.click();
  await expect(page.getByTestId('mcp-args-result')).toHaveText('{"pr_number":"42"}');
  await expect(page.getByTestId('mcp-picked')).toHaveText('summarize_pr');
});

test('Escape cancels the argument dialog without reporting a result', async ({ page }) => {
  await promptsDialog(page).getByRole('button', { name: 'summarize_pr' }).click();

  const dialog = page.getByRole('dialog', { name: 'Arguments for summarize_pr' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');

  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('mcp-args-result')).toHaveText('');
  await expect(page.getByTestId('mcp-picked')).toHaveText('');
});

test("the consent dialog: Confirm reports allowed, Cancel does not", async ({ page }) => {
  await page.getByRole('button', { name: 'Open consent dialog' }).click();
  const cancelled = page.getByRole('dialog', { name: "Allow this server's resources" });
  await cancelled.getByRole('button', { name: 'Cancel' }).click();
  await expect(cancelled).toHaveCount(0);
  await expect(page.getByTestId('mcp-consent-result')).toHaveText('cancelled');

  await page.getByRole('button', { name: 'Open consent dialog' }).click();
  const allowed = page.getByRole('dialog', { name: "Allow this server's resources" });
  await allowed.getByRole('button', { name: 'Allow' }).click();
  await expect(allowed).toHaveCount(0);
  await expect(page.getByTestId('mcp-consent-result')).toHaveText('allowed');
});
