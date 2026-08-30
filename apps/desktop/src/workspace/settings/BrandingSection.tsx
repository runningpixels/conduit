import { useEffect, useMemo, useRef, useState } from 'react';
import type { BrandConfig, BrandPalette, BrandThemes } from '@conduit/config-schema';
import type { AppSettings } from '../../ipc/contracts';
import {
  applyBrandEdits,
  clearBrandConfig,
  clearBrandLogo,
  exportBrandConfigDialog,
  getBrandConfig,
  getBrandWarnings,
  importBrandFileDialog,
  saveBrandLogo,
  type BrandWarning,
} from '../../ipc/client';
import { applyBrand, applyBrandTheme, clearBrand, isValidHexColor } from '../../brand/applyBrand';
import { appName, setBrand } from '../../brand';
import { fetchBrandLogo } from '../../brand/logo';
import { resolveTheme } from '../../theme';
import { ConfirmDialog } from '@conduit/ui';
import { BrandMark } from '../../icons';

interface BrandingSectionProps {
  settings: AppSettings;
  onUpdate: (next: AppSettings) => void;
  onStatus: (message: string) => void;
  /**
   * Optional coherence hook: when the app shell threads its own
   * `brandConfig`/`brandLogo` state (App.tsx) through here, calling this
   * after every successful save/import/reset/logo change keeps the sidebar
   * wordmark and the OS-theme-change re-apply effect (App.tsx) in sync
   * without waiting for a reload. Entirely optional — this section fetches
   * and applies everything it needs on its own either way, matching
   * `AppearanceSection`'s self-contained idiom.
   */
  onBrandChange?: (config: BrandConfig | null, logo: string | null) => void;
}

type EditableIdentity = { appName: string; displayName: string; tagline: string };

/**
 * Seed values only — shown in the colour editor before any brand exists, so
 * the swatches start from the stock look instead of black. They mirror
 * `packages/ui/src/tokens.css`'s `:root` / `[data-theme="light"]` defaults
 * and the `anthropic` provider accent (the shipped one) at the time this was
 * written. Drift here only changes what an *unedited* swatch shows before
 * the user touches it — `applyBrand.ts`'s hex grammar and Rust's own
 * validator are what actually keep an applied brand correct, not this
 * constant, so there is no correctness risk if tokens.css moves on without
 * this being updated.
 */
const SEED_PALETTE_DARK: BrandPalette = {
  bg: '#262624',
  bgSide: '#1f1e1d',
  card: '#30302e',
  cardHi: '#3a3a37',
  line: '#3d3d3a',
  lineSoft: '#343431',
  lineHi: '#4d4d49',
  ink: '#eceae2',
  ink2: '#c4c2ba',
  ink3: '#a6a39d',
  hue: '#d97757',
  hueText: '#e08f75',
  hueSolid: '#c5522d',
  onHue: '#ffffff',
  ok: '#4ade80',
  warn: '#fbbf24',
  err: '#f97e7e',
  link: '#9db8e8',
};

const SEED_PALETTE_LIGHT: BrandPalette = {
  bg: '#faf9f5',
  bgSide: '#f0eee6',
  card: '#ffffff',
  cardHi: '#f5f4ee',
  line: '#e4e1d7',
  lineSoft: '#edeae1',
  lineHi: '#cfcbbf',
  ink: '#29271f',
  ink2: '#59564c',
  ink3: '#706c61',
  hue: '#b04f2b',
  hueText: '#b04f2b',
  hueSolid: '#bd5836',
  onHue: '#ffffff',
  ok: '#147c3b',
  warn: '#af5109',
  err: '#b91c1c',
  link: '#1f5fa8',
};

const SEED_THEMES: BrandThemes = { dark: SEED_PALETTE_DARK, light: SEED_PALETTE_LIGHT };

/** The 18-key curated surface (plan §2), in the order the editor shows them. */
const PALETTE_FIELDS: { key: keyof BrandPalette; label: string }[] = [
  { key: 'bg', label: 'Background' },
  { key: 'bgSide', label: 'Sidebar background' },
  { key: 'card', label: 'Card' },
  { key: 'cardHi', label: 'Card (hover)' },
  { key: 'line', label: 'Border' },
  { key: 'lineSoft', label: 'Border (soft)' },
  { key: 'lineHi', label: 'Border (emphasis)' },
  { key: 'ink', label: 'Text' },
  { key: 'ink2', label: 'Text (secondary)' },
  { key: 'ink3', label: 'Text (tertiary)' },
  { key: 'hue', label: 'Accent' },
  { key: 'hueText', label: 'Accent (text)' },
  { key: 'hueSolid', label: 'Accent (solid fill)' },
  { key: 'onHue', label: 'Text on accent' },
  { key: 'ok', label: 'Success' },
  { key: 'warn', label: 'Warning' },
  { key: 'err', label: 'Error' },
  { key: 'link', label: 'Link' },
];

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === 'string' ? e : String(e);
}

function deriveIdentity(config: BrandConfig | null): EditableIdentity {
  return {
    appName: config?.identity.appName ?? '',
    displayName: config?.identity.displayName ?? '',
    tagline: config?.identity.tagline ?? '',
  };
}

function deriveThemes(config: BrandConfig | null): BrandThemes {
  return config?.palette ?? SEED_THEMES;
}

/** Every out-of-grammar key in one theme's palette, field label included so
 *  the message says which swatch is wrong instead of just "invalid colour". */
function paletteFieldErrors(palette: BrandPalette): Partial<Record<keyof BrandPalette, string>> {
  const errors: Partial<Record<keyof BrandPalette, string>> = {};
  for (const { key, label } of PALETTE_FIELDS) {
    if (!isValidHexColor(palette[key])) {
      errors[key] = `${label}: enter a hex colour like #RRGGBB, #RGB, or #RRGGBBAA.`;
    }
  }
  return errors;
}

/** Best-effort normalisation for `<input type="color">`, which only accepts
 *  `#rrggbb` — it cannot express the 3- or 8-digit forms this app's grammar
 *  allows. The text field beside it stays the source of truth; this is a
 *  picker convenience only. */
function toColorInputValue(hex: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) return hex.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
    const [, r, g, b] = hex;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  if (/^#[0-9a-fA-F]{8}$/.test(hex)) return hex.slice(0, 7).toLowerCase();
  return '#000000';
}

function fileToBytes(file: File): Promise<number[]> {
  return file.arrayBuffer().then((buffer) => Array.from(new Uint8Array(buffer)));
}

/**
 * Settings → Branding (white-label plan §4, Phase 3). Modelled on
 * `AppearanceSection`: self-contained, fetches its own state, takes
 * `settings`/`onUpdate` for the one field it owns on `AppSettings`
 * (`brandingEnabled`).
 *
 * Everything else — identity, palette, logo — lives in `brand.md` on disk,
 * reached through the brand IPC surface rather than `AppSettings`. This
 * section is Mode A's only user-facing entry point: without it, Phases 0-2
 * are validated code with no way for a person to ever reach them.
 */
export function BrandingSection({ settings, onUpdate, onStatus, onBrandChange }: BrandingSectionProps) {
  const enabled = settings.brandingEnabled;
  const resolvedTheme = resolveTheme(settings.theme);

  const [loaded, setLoaded] = useState(false);
  const [savedConfig, setSavedConfig] = useState<BrandConfig | null>(null);
  const [logo, setLogo] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<BrandWarning[]>([]);

  const [identity, setIdentity] = useState<EditableIdentity>(() => deriveIdentity(null));
  const [themes, setThemes] = useState<BrandThemes>(() => deriveThemes(null));
  const [editingTheme, setEditingTheme] = useState<'dark' | 'light'>(resolvedTheme);

  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [logoUploading, setLogoUploading] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [logoDropActive, setLogoDropActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch the authoritative state on mount, and again whenever the toggle
  // flips on: `get_brand_config`/`get_brand_warnings` are gated on
  // `branding_enabled` in Rust and return null/empty while it's off, so
  // turning it on is the one moment a real on-disk brand.md (if any) becomes
  // visible again.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [cfg, logoUri, warn] = await Promise.all([
          getBrandConfig(),
          fetchBrandLogo(),
          getBrandWarnings().catch(() => []),
        ]);
        if (cancelled) return;
        setSavedConfig(cfg);
        setIdentity(deriveIdentity(cfg));
        setThemes(deriveThemes(cfg));
        setLogo(logoUri);
        setWarnings(warn);
        onBrandChange?.(cfg, logoUri);
      } catch {
        // getBrandConfig/getBrandWarnings are already registered (Phase 1),
        // but degrade the same way as everywhere else in this codebase if
        // IPC is unreachable: start from the seed defaults rather than
        // throwing out of a settings section.
        if (!cancelled) {
          setSavedConfig(null);
          setIdentity(deriveIdentity(null));
          setThemes(deriveThemes(null));
          setLogo(null);
          setWarnings([]);
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Deliberately keyed on settings.brandingEnabled alone, not on
    // onBrandChange: the latter is expected to be a fresh closure on every
    // App.tsx render, and re-running this fetch whenever it changes identity
    // would re-fetch on every unrelated App re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.brandingEnabled]);

  const dirty = useMemo(() => {
    const baseline = { identity: deriveIdentity(savedConfig), themes: deriveThemes(savedConfig) };
    return JSON.stringify({ identity, themes }) !== JSON.stringify(baseline);
  }, [identity, themes, savedConfig]);

  const darkErrors = useMemo(() => paletteFieldErrors(themes.dark), [themes.dark]);
  const lightErrors = useMemo(() => paletteFieldErrors(themes.light), [themes.light]);
  const currentErrors = editingTheme === 'dark' ? darkErrors : lightErrors;
  const allValid = Object.keys(darkErrors).length === 0 && Object.keys(lightErrors).length === 0;

  // ── Live preview (plan item 16) ─────────────────────────────────────────
  // Applied straight through applyBrandTheme/setBrand — never applyBrand()
  // itself, which also writes the pre-paint localStorage cache. An unsaved
  // draft must never land in that cache: a crash or refresh replaying it
  // would make a never-saved edit look like it had been. Cache writes only
  // happen after Rust confirms something (save/import/reset below).
  useEffect(() => {
    if (!enabled || !loaded) return;
    setBrand(identity);
  }, [enabled, loaded, identity]);

  useEffect(() => {
    if (!enabled || !loaded) return;
    if (editingTheme !== resolvedTheme) return; // see the note near the theme switcher
    applyBrandTheme({ palette: themes }, resolvedTheme);
  }, [enabled, loaded, editingTheme, resolvedTheme, themes]);

  // Refs so the unmount cleanup below reads the latest values without
  // re-registering itself (and its own teardown) on every keystroke.
  const savedConfigRef = useRef(savedConfig);
  const dirtyRef = useRef(dirty);
  const resolvedThemeRef = useRef(resolvedTheme);
  const enabledRef = useRef(enabled);
  useEffect(() => {
    savedConfigRef.current = savedConfig;
    dirtyRef.current = dirty;
    resolvedThemeRef.current = resolvedTheme;
    enabledRef.current = enabled;
  });

  // Leaving the section with an unsaved draft still live must not leave the
  // running app on preview values forever — only Save persists. Restore
  // whatever was last actually on disk (or the stock look, if nothing was).
  useEffect(() => {
    return () => {
      if (!enabledRef.current || !dirtyRef.current) return;
      if (savedConfigRef.current) applyBrand(savedConfigRef.current, resolvedThemeRef.current);
      else clearBrand();
    };
  }, []);

  function handleToggleEnabled() {
    const next = !enabled;
    onUpdate({ ...settings, brandingEnabled: next });
    if (!next) {
      clearBrand();
      onBrandChange?.(null, null);
    }
  }

  function updatePaletteField(key: keyof BrandPalette, value: string) {
    setThemes((prev) => ({ ...prev, [editingTheme]: { ...prev[editingTheme], [key]: value } }));
  }

  function handleCopyToOtherTheme() {
    const other = editingTheme === 'dark' ? 'light' : 'dark';
    setThemes((prev) => ({ ...prev, [other]: { ...prev[editingTheme] } }));
    onStatus(`Copied the ${editingTheme} palette to ${other}.`);
  }

  async function handleSave() {
    if (!allValid) {
      setSaveError('Fix the highlighted colour values before saving.');
      return;
    }
    const trimmedAppName = identity.appName.trim();
    if (!trimmedAppName) {
      setSaveError('App name is required.');
      return;
    }
    setSaveError(null);
    setSaving(true);
    try {
      const payload: BrandConfig = {
        schemaVersion: savedConfig?.schemaVersion ?? 1,
        identity: {
          appName: trimmedAppName,
          displayName: identity.displayName.trim() || trimmedAppName,
          ...(identity.tagline.trim() ? { tagline: identity.tagline.trim() } : {}),
        },
        palette: themes,
        ...(savedConfig?.logo ? { logo: savedConfig.logo } : {}),
      };
      const result = await applyBrandEdits(payload);
      setSavedConfig(result);
      setIdentity(deriveIdentity(result));
      setThemes(deriveThemes(result));
      if (enabled) applyBrand(result, resolvedTheme);
      onBrandChange?.(result, logo);
      onStatus('Brand saved.');
    } catch (e) {
      const message = describeError(e);
      setSaveError(message);
      onStatus(`Save failed: ${message}`);
    } finally {
      setSaving(false);
    }
  }

  function handleRevert() {
    setIdentity(deriveIdentity(savedConfig));
    setThemes(deriveThemes(savedConfig));
    setSaveError(null);
    if (savedConfig) applyBrand(savedConfig, resolvedTheme);
    else clearBrand();
    onBrandChange?.(savedConfig, logo);
    onStatus('Reverted to the last saved brand.');
  }

  async function uploadLogoFile(file: File) {
    if (!enabled) return;
    setLogoError(null);
    setLogoUploading(true);
    try {
      const bytes = await fileToBytes(file);
      await saveBrandLogo(bytes, file.name);
      const uri = await fetchBrandLogo();
      setLogo(uri);
      onBrandChange?.(savedConfig, uri);
      onStatus('Logo updated.');
    } catch (e) {
      // Rust's validation messages (oversized, wrong type, hostile SVG) are
      // written to be actionable — shown verbatim, not swapped for a
      // generic failure string.
      setLogoError(describeError(e));
    } finally {
      setLogoUploading(false);
    }
  }

  function handleLogoDragOver(event: React.DragEvent) {
    if (!enabled) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setLogoDropActive(true);
  }

  function handleLogoDragLeave(event: React.DragEvent) {
    if (event.currentTarget.contains(event.relatedTarget as Node)) return;
    setLogoDropActive(false);
  }

  function handleLogoDrop(event: React.DragEvent) {
    event.preventDefault();
    setLogoDropActive(false);
    if (!enabled) return;
    const file = event.dataTransfer.files[0];
    if (file) void uploadLogoFile(file);
  }

  function handleLogoInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void uploadLogoFile(file);
  }

  async function handleRemoveLogo() {
    setLogoError(null);
    try {
      await clearBrandLogo();
      setLogo(null);
      onBrandChange?.(savedConfig, null);
      onStatus('Logo removed.');
    } catch (e) {
      setLogoError(describeError(e));
    }
  }

  /**
   * Both the picker and the action happen inside one Rust round trip now
   * (ADR 008) — see `importBrandFileDialog`'s doc comment in ipc/client.ts.
   * A `null` resolution means the user cancelled the OS picker, which is not
   * an error: no error text, no status toast, and no state change. Getting
   * this wrong (treating cancel as a failure) is the classic file-picker bug.
   */
  async function handleImport() {
    setSaveError(null);
    setImporting(true);
    try {
      const result = await importBrandFileDialog();
      if (result === null) return; // cancelled
      setSavedConfig(result);
      setIdentity(deriveIdentity(result));
      setThemes(deriveThemes(result));
      const uri = await fetchBrandLogo();
      setLogo(uri);
      if (enabled) applyBrand(result, resolvedTheme);
      onBrandChange?.(result, uri);
      onStatus('Brand imported.');
    } catch (e) {
      const message = describeError(e);
      setSaveError(message);
      onStatus(`Import failed: ${message}`);
    } finally {
      setImporting(false);
    }
  }

  /** Same cancel contract as handleImport above: a `null` resolution means
   *  the user cancelled the save-location picker, not a failure. */
  async function handleExport() {
    setSaveError(null);
    setExporting(true);
    try {
      const result = await exportBrandConfigDialog();
      if (result === null) return; // cancelled
      onStatus('Brand exported.');
    } catch (e) {
      const message = describeError(e);
      setSaveError(message);
      onStatus(`Export failed: ${message}`);
    } finally {
      setExporting(false);
    }
  }

  async function handleResetConfirmed() {
    setConfirmReset(false);
    setResetting(true);
    setSaveError(null);
    try {
      await clearBrandConfig();
      clearBrand();
      setSavedConfig(null);
      setIdentity(deriveIdentity(null));
      setThemes(deriveThemes(null));
      setLogo(null);
      onBrandChange?.(null, null);
      onStatus('Brand reset — back to the stock look.');
    } catch (e) {
      const message = describeError(e);
      setSaveError(message);
      onStatus(`Reset failed: ${message}`);
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <span>Branding</span>
      </div>
      <p className="sheet-sub">
        Rebrand this install for a demo or a client — name, logo, and the 18 colours the shell reads
        from. Applies at runtime, one click to undo.
      </p>

      {/* Plan item 9: honesty about Mode B, not fake disabled inputs. */}
      <p className="branding-note">
        This can&rsquo;t change the app icon, the installer or executable name, or the bundle
        identifier — those are set when {appName()} is built, not at runtime. A packaged rebrand
        (&ldquo;Mode B&rdquo;) changes those too, but it&rsquo;s a separate, build-time process.
      </p>

      <div className="srow">
        <span className="srow-text">
          <b>Enable branding</b>
          <small>Turn off to restore the stock look immediately</small>
        </span>
        <button
          className="toggle"
          type="button"
          role="switch"
          aria-pressed={enabled}
          aria-label="Enable branding"
          onClick={handleToggleEnabled}
        />
      </div>

      <fieldset className="branding-fieldset" disabled={!enabled}>
        <legend className="grp-label">Brand</legend>

        {warnings.length > 0 && (
          <div className="brand-warnings" role="status">
            <div className="grp-label">Advisory — not blocking</div>
            <p style={{ margin: '0 0 6px', fontSize: 12, color: 'var(--ink-2)' }}>
              This is your own install, so nothing here is rejected — worth a look, not a blocker.
            </p>
            {warnings.map((w, i) => (
              <p className="brand-warning-item" key={`${w.field}-${i}`}>
                {w.message}
              </p>
            ))}
          </div>
        )}

        <div className="grp">
          <div className="grp-label">Identity</div>
          <div className="form-grid">
            <label className="field">
              <span className="field-label">App name</span>
              <input
                className="brand-text-input"
                type="text"
                value={identity.appName}
                placeholder={appName()}
                onChange={(e) => setIdentity((prev) => ({ ...prev, appName: e.target.value }))}
              />
            </label>
            <label className="field">
              <span className="field-label">Display name</span>
              <input
                className="brand-text-input"
                type="text"
                value={identity.displayName}
                placeholder={identity.appName || appName()}
                onChange={(e) => setIdentity((prev) => ({ ...prev, displayName: e.target.value }))}
              />
            </label>
            <label className="field">
              <span className="field-label">Tagline</span>
              <input
                className="brand-text-input"
                type="text"
                value={identity.tagline}
                placeholder={`Message ${identity.appName || appName()}…`}
                onChange={(e) => setIdentity((prev) => ({ ...prev, tagline: e.target.value }))}
              />
            </label>
          </div>
        </div>

        <div className="grp">
          <div className="grp-label">Logo</div>
          <div
            className={`brand-dropzone${logoDropActive ? ' drop-active' : ''}`}
            onDragOver={handleLogoDragOver}
            onDragLeave={handleLogoDragLeave}
            onDrop={handleLogoDrop}
          >
            <div className="brand-dropzone-preview">
              {logo ? (
                <img src={logo} alt="Brand logo preview" className="brand-logo-img" />
              ) : (
                <BrandMark className="brand-logo-img" />
              )}
            </div>
            <div className="brand-dropzone-body">
              <p style={{ margin: 0, fontSize: 12.5, color: 'var(--ink-2)' }}>
                Drop a PNG, WebP, JPEG, or SVG here, or
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                hidden
                aria-hidden
                data-testid="brand-logo-file-input"
                onChange={handleLogoInputChange}
              />
              <div className="brand-logo-actions">
                <button
                  className="btn"
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={logoUploading}
                >
                  {logoUploading ? 'Uploading…' : 'Choose file'}
                </button>
                <button className="btn danger" type="button" disabled={!logo} onClick={() => void handleRemoveLogo()}>
                  Remove logo
                </button>
              </div>
            </div>
          </div>
          {logoError && (
            <p className="brand-error" role="alert">
              {logoError}
            </p>
          )}
        </div>

        <div className="grp">
          <div className="grp-label">Colours</div>
          <div className="brand-theme-switch" role="group" aria-label="Editing theme">
            <button
              type="button"
              className="brand-theme-btn"
              aria-pressed={editingTheme === 'dark'}
              onClick={() => setEditingTheme('dark')}
            >
              Dark
            </button>
            <button
              type="button"
              className="brand-theme-btn"
              aria-pressed={editingTheme === 'light'}
              onClick={() => setEditingTheme('light')}
            >
              Light
            </button>
            <button className="btn" type="button" onClick={handleCopyToOtherTheme}>
              Copy to {editingTheme === 'dark' ? 'light' : 'dark'}
            </button>
          </div>
          {editingTheme !== resolvedTheme && (
            <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--ink-3)' }}>
              Live preview shows your current {resolvedTheme} appearance. Switch Appearance → Theme
              to {editingTheme} to preview these values directly.
            </p>
          )}
          <div className="brand-palette-grid">
            {PALETTE_FIELDS.map(({ key, label }) => {
              const value = themes[editingTheme][key];
              const error = currentErrors[key];
              return (
                <div className="brand-swatch" key={key}>
                  {/* A plain span, not a <label htmlFor>: both inputs below
                      already carry their own aria-label, and associating
                      this text with just one of them (via htmlFor) would
                      make "Background" ambiguous between two elements
                      instead of unambiguously naming either. */}
                  <span className="field-label">{label}</span>
                  <div className="brand-swatch-controls">
                    <input
                      type="color"
                      aria-label={`${label} colour picker`}
                      value={toColorInputValue(value)}
                      onChange={(e) => updatePaletteField(key, e.target.value)}
                    />
                    <input
                      className={`brand-text-input brand-hex-input${error ? ' invalid' : ''}`}
                      type="text"
                      aria-label={label}
                      value={value}
                      onChange={(e) => updatePaletteField(key, e.target.value)}
                    />
                  </div>
                  {error && <span className="brand-field-error">{error}</span>}
                </div>
              );
            })}
          </div>
        </div>

        {dirty && (
          <div className="brand-dirty-banner">
            <span>Unsaved changes — previewed live, not yet saved.</span>
            <div className="actions">
              <button className="btn primary" type="button" disabled={saving || !allValid} onClick={() => void handleSave()}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button className="btn" type="button" disabled={saving} onClick={handleRevert}>
                Revert
              </button>
            </div>
          </div>
        )}

        {saveError && (
          <p className="brand-error" role="alert">
            {saveError}
          </p>
        )}

        <div className="grp">
          <div className="grp-label">Import, export &amp; reset</div>
          <div className="actions">
            <button className="btn" type="button" disabled={importing} onClick={() => void handleImport()}>
              {importing ? 'Importing…' : 'Import brand.md…'}
            </button>
            <button className="btn" type="button" disabled={exporting} onClick={() => void handleExport()}>
              {exporting ? 'Exporting…' : 'Export…'}
            </button>
            <button className="btn danger" type="button" disabled={resetting} onClick={() => setConfirmReset(true)}>
              {resetting ? 'Resetting…' : 'Reset to stock'}
            </button>
          </div>
        </div>
      </fieldset>

      <ConfirmDialog
        open={confirmReset}
        title="Reset branding?"
        description="Deletes the active brand.md and its logo from disk and restores the stock look. This cannot be undone from the app."
        confirmLabel="Reset branding"
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => void handleResetConfirmed()}
      />
    </div>
  );
}
