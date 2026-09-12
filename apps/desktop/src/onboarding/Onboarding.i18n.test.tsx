import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type { AppSettings, MigrationRecoveryInfo } from '../ipc/contracts';
import { renderWithIntl } from '../test/renderWithIntl';
import { MigrationRecoveryNotice, Onboarding } from './Onboarding';

/// The Phase 0 exit criterion: the same components the English tests exercise,
/// rendered in German, from the real `messages/de.json`.
///
/// Kept apart from `Onboarding.test.tsx` and `MigrationRecoveryNotice.test.tsx`
/// on purpose — those two are the proof that extraction cost no test edits, and
/// they are worth nothing as that proof if this file's assertions are folded
/// into them. They cover behaviour in English; this one covers language.

vi.mock('../ipc/client', () => ({
  getOnboardingState: vi.fn(),
  updateSettings: vi.fn(),
  acknowledgeMigrationRecovery: vi.fn().mockResolvedValue(undefined),
  discardMigrationBackup: vi.fn().mockResolvedValue({ removedPaths: [], freedBytes: 0 }),
  requestLocalDataWipe: vi.fn().mockResolvedValue({ requiresRestart: true, estimatedBytes: 0 }),
  restartApp: vi.fn().mockResolvedValue(undefined),
  listProviderModels: vi.fn().mockResolvedValue([]),
  listProviderDescriptors: vi.fn().mockResolvedValue([]),
  loadProviderCredentialReference: vi.fn().mockResolvedValue({
    providerId: 'anthropic',
    credentialRef: 'keychain://conduit/anthropic',
    storedInKeychain: false,
  }),
  saveProviderCredential: vi.fn(),
  validateProviderCredentials: vi.fn(),
  getConnectorRuntimeStates: vi.fn().mockResolvedValue([]),
  listConnectorCapabilities: vi.fn().mockResolvedValue([]),
  listConnectorGrants: vi.fn().mockResolvedValue([]),
  discoverConnector: vi.fn().mockResolvedValue([]),
  startConnector: vi.fn(),
  stopConnector: vi.fn(),
  revokeConnectorGrant: vi.fn(),
  addLocalConnector: vi.fn(),
  addRemoteConnector: vi.fn(),
  searchMcpRegistry: vi.fn().mockResolvedValue([]),
  signinRemoteConnector: vi.fn(),
  listToolApprovalMemory: vi.fn().mockResolvedValue([]),
  revokeToolApprovalMemory: vi.fn().mockResolvedValue(true),
}));

const settings = {
  activeProvider: 'anthropic',
  activeModel: 'claude-sonnet-4',
  localOnly: true,
  diagnosticsEnabled: true,
  theme: 'system',
  language: 'system',
  providerEndpoints: {},
  artifactRemoteAllowlist: [],
  artifactStyledPreview: true,
  updateChannel: 'stable',
  updateCheckEnabled: true,
  updatePolicy: 'manual' as const,
  onboardingCompleted: false,
  webSearchEnabled: false,
  webSearch: {
    mode: 'auto' as const,
    localBackend: 'duckduckgo',
    searchContextSize: 'medium',
    allowedDomains: [],
    blockedDomains: [],
    externalWebAccess: true,
    returnTokenBudget: 'default',
    includeSources: false,
  },
  webSearchConsentAcknowledged: false,
  agent: { maxSteps: 25, wallClockBudgetSecs: 300 },
  keychainMode: 'os',
  brandingEnabled: false,
  workspaceToolsEnabled: false,
  workspaceRoot: null,
  workspaceToolsConsentAcknowledged: false,
  generationControls: null,
  userInstructions: null,
  contextCompactEnabled: true,
  contextCompactThresholdPercent: 90,
  memoryEnabled: true,
} as AppSettings;

const recovery: MigrationRecoveryInfo = {
  backupPath: 'C:\\Users\\x\\AppData\\Local\\x\\data\\store.sqlite.corrupt-1787026415.bak',
  error: 'migration failed: migration 1 was previously applied but has been modified',
  backupExists: true,
  backupBytes: 2_621_440,
};

const renderOnboarding = (locale: string) =>
  renderWithIntl(
    <Onboarding
      settings={settings}
      onSettingsChange={vi.fn()}
      onStatus={vi.fn()}
      status={null}
      onComplete={vi.fn()}
    />,
    { locale },
  );

const renderNotice = (locale: string, overrides: Partial<MigrationRecoveryInfo> = {}) =>
  renderWithIntl(
    <MigrationRecoveryNotice
      recovery={{ ...recovery, ...overrides }}
      onStatus={vi.fn()}
      onDismissed={vi.fn()}
    />,
    { locale },
  );

describe('Onboarding in German', () => {
  it('renders the welcome screen from the de catalog', async () => {
    await renderOnboarding('de');
    expect(screen.getByText(/^Willkommen bei /)).toBeInTheDocument();
    expect(screen.getByText('Sprache und Erscheinungsbild festlegen')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Weiter' })).toBeInTheDocument();
  });

  it('names every language in its own language, not in the interface language', async () => {
    await renderOnboarding('de');
    // The reason the picker is reachable at all from a screen the user may not
    // be able to read: "Français" is findable in a German UI, "Französisch" is
    // not findable by someone who only reads French. `nativeName` is the whole
    // point of the locale table, so pin it here rather than trusting it.
    const select = screen.getByLabelText('Sprache');
    expect(select).toHaveDisplayValue('System');
    for (const native of ['Deutsch', 'Français', '日本語', '简体中文']) {
      expect(screen.getByRole('option', { name: native })).toBeInTheDocument();
    }
  });

  it('keeps the product name out of the catalog and lets the brand supply it', async () => {
    await renderOnboarding('de');
    // German chrome, English product name, in one sentence — which is the
    // whole point of `{appName}` (D8) and of the do-not-translate list (D7).
    expect(screen.getByRole('heading', { level: 2 }).textContent).toMatch(/^Willkommen bei \S+$/);
  });

  it('translates the step dots without losing the numbering', async () => {
    await renderOnboarding('de');
    expect(screen.getByRole('button', { name: '1 · Erscheinungsbild' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2 · Anbieter' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3 · Datenschutz' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '4 · Connectors' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '5 · Abschluss' })).toBeInTheDocument();
  });

  it('translates aria-labels, not just visible text', async () => {
    await renderOnboarding('de');
    // A screen-reader user in German gets German landmarks. Half-translating
    // this is the failure that never shows up in a screenshot review.
    expect(screen.getByRole('navigation', { name: 'Onboarding-Fortschritt' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Sprache und Erscheinungsbild' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '2 · Anbieter' }));
    expect(screen.getByRole('region', { name: 'Anbieter auswählen' })).toBeInTheDocument();
  });

  it('translates the privacy step, including the copy reused from Settings', async () => {
    await renderOnboarding('de');
    fireEvent.click(screen.getByRole('button', { name: '3 · Datenschutz' }));
    expect(screen.getByRole('region', { name: 'Datenschutz und Updates' })).toBeInTheDocument();
    expect(screen.getByText('Was diesen Rechner verlässt')).toBeInTheDocument();
    // Reused from `settings.privacy.*`, so this is also the check that reuse
    // did not quietly pull an English string onto a German screen.
    expect(screen.getByRole('checkbox', { name: 'Nur-lokal-Modus' })).toBeInTheDocument();
    expect(screen.getByLabelText('Schlüsselbund-Modus')).toBeInTheDocument();
  });

  it('still renders English when English is what was asked for', async () => {
    // The same helper, the same components — the difference is entirely the
    // catalog, which is the property the whole design rests on.
    await renderOnboarding('en');
    expect(screen.getByText(/^Welcome to /)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
  });
});

describe('MigrationRecoveryNotice in German', () => {
  it('translates the destructive-action copy', async () => {
    await renderNotice('de');
    // The highest-consequence prose in the app, and the reason onboarding was
    // chosen as the spike screen.
    expect(screen.getByRole('button', { name: 'Daten löschen…' })).toBeInTheDocument();
    expect(screen.getByText(/konnte deine lokalen Daten nicht aktualisieren$/)).toBeInTheDocument();
  });

  it('renders the size into the German sentence rather than splicing an adjective', async () => {
    await renderNotice('de');
    screen.getByRole('button', { name: 'Daten löschen…' }).click();
    // The separator is deliberately not pinned. `formatBytes` still uses
    // `.toFixed(1)`, so this renders "2.5 MB" where German wants "2,5 MB" —
    // a real bug, and D16's job to fix along with the other locale-blind
    // formatters in Phase 2. Asserting the English separator here would cement
    // it; asserting the German one would fail today. Assert the shape instead.
    expect(await screen.findByText(/^Entfernt das [\d.,]+ MB Backup/)).toBeInTheDocument();
  });

  it('falls back to the whole-sentence variant when the backup is gone', async () => {
    await renderNotice('de', { backupExists: false });
    screen.getByRole('button', { name: 'Daten löschen…' }).click();
    // Not "Entfernt das gespeicherte {size} Backup" — a different sentence,
    // which is what splitting the key bought us.
    expect(await screen.findByText(/^Entfernt das gespeicherte Backup/)).toBeInTheDocument();
  });

  it('spells the confirmation without softening it', async () => {
    // "cannot be undone" is the one phrase in this screen that must survive
    // translation intact; a hedged German rendering here is a data-loss bug.
    await renderNotice('de');
    screen.getByRole('button', { name: 'Daten löschen…' }).click();
    expect(
      await screen.findByText('Mir ist klar, dass dies nicht rückgängig gemacht werden kann.'),
    ).toBeInTheDocument();
  });
});
