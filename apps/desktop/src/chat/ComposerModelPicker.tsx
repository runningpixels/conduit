import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { AppSettings, ModelInfo, ProviderDescriptor } from '../ipc/contracts';
import { listProviderDescriptors, listProviderModels, updateSettings } from '../ipc/client';
import { ModelIcon } from '../icons';

interface ComposerModelPickerProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  disabled?: boolean;
}

export interface ComposerModelPickerHandle {
  /// Open the model switcher popover (used by the status line's
  /// provider/model segment). No-op while disabled or busy.
  open: () => void;
}

export const ComposerModelPicker = forwardRef<ComposerModelPickerHandle, ComposerModelPickerProps>(
  function ComposerModelPicker(
    {
      settings,
      onSettingsChange,
      disabled = false,
    }: ComposerModelPickerProps,
    ref,
  ) {
    const [open, setOpen] = useState(false);
    const [providers, setProviders] = useState<ProviderDescriptor[]>([]);
    const [models, setModels] = useState<ModelInfo[]>([]);
    const [busy, setBusy] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    useImperativeHandle(ref, () => ({
      open: () => {
        if (!disabled && !busy) setOpen(true);
      },
    }));

  const activeDescriptor = providers.find((p) => p.id === settings.activeProvider);
  const activeModelLabel =
    models.find((m) => m.id === settings.activeModel)?.displayName ?? settings.activeModel;

  useEffect(() => {
    void (async () => {
      try {
        setProviders(await listProviderDescriptors());
      } catch {
        setProviders([]);
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        setModels(await listProviderModels(settings.activeProvider));
      } catch {
        setModels([]);
      }
    })();
  }, [settings.activeProvider]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    // P5.1 — focus trap: keep Tab/Shift+Tab cycling inside the popover.
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const popover = rootRef.current?.querySelector('.composer-popover');
      if (!popover) return;
      const focusables = Array.from(
        popover.querySelectorAll<HTMLElement>('select, input, button, [tabindex]:not([tabindex="-1"])'),
      ).filter((el) => !el.hasAttribute('disabled'));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  async function persistSettings(next: AppSettings) {
    setBusy(true);
    try {
      const persisted = await updateSettings(next);
      onSettingsChange(persisted);
    } catch {
      onSettingsChange(next);
    } finally {
      setBusy(false);
    }
  }

  function handleProviderChange(providerId: string) {
    const descriptor = providers.find((p) => p.id === providerId);
    const existingEndpoint = settings.providerEndpoints?.[providerId];
    const nextEndpoints = { ...settings.providerEndpoints };
    if (descriptor?.defaultBaseUrl && !existingEndpoint?.baseUrl) {
      nextEndpoints[providerId] = {
        ...existingEndpoint,
        baseUrl: descriptor.defaultBaseUrl,
      };
    }
    void persistSettings({
      ...settings,
      activeProvider: providerId,
      providerEndpoints: nextEndpoints,
    });
  }

  function handleModelChange(modelId: string) {
    void persistSettings({ ...settings, activeModel: modelId });
    setOpen(false);
  }

  const sortedProviders = [...providers].sort(
    (a, b) => a.tier - b.tier || a.displayName.localeCompare(b.displayName),
  );

  return (
    <div className="composer-model-picker" ref={rootRef}>
      <button
        className="tool-btn model-trigger"
        type="button"
        title="Switch model"
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled || busy}
        onClick={() => setOpen((value) => !value)}
      >
        <ModelIcon />
        <span className="model-label">{activeModelLabel}</span>
        <span className="model-chevron" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="composer-popover" role="dialog" aria-label="Model switcher" aria-modal="true">
          <div className="composer-popover-head">
            <span>Model</span>
            {activeDescriptor?.displayName ? (
              <span className="composer-popover-sub">{activeDescriptor.displayName}</span>
            ) : null}
          </div>
          <label className="composer-popover-field">
            <span>Provider</span>
            <select
              value={settings.activeProvider}
              onChange={(e) => handleProviderChange(e.target.value)}
              disabled={busy}
            >
              {sortedProviders.length > 0 ? (
                sortedProviders.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.displayName}
                  </option>
                ))
              ) : (
                <>
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI</option>
                  <option value="ollama">Ollama</option>
                </>
              )}
            </select>
          </label>
          <label className="composer-popover-field">
            <span>Model</span>
            {models.length > 0 ? (
              <select
                value={settings.activeModel}
                onChange={(e) => handleModelChange(e.target.value)}
                disabled={busy}
              >
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName ?? model.id}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={settings.activeModel}
                onChange={(e) => handleModelChange(e.target.value)}
                disabled={busy}
                placeholder="Model id"
              />
            )}
          </label>
          <p className="composer-popover-note">
            Changes apply app-wide. Manage credentials in Settings.
          </p>
        </div>
      )}
    </div>
  );
  },
);

