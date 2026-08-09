/**
 * ComposerModelPicker — the model switcher at the composer's bottom-right
 * (V9 §2.3).
 *
 * V7 put two `<select>`s behind a popover: one for provider, one for model,
 * each writing settings on change. That was two decisions and two writes for
 * what is one act — "use this model" — and it meant a cross-provider switch
 * briefly persisted a provider/model pair that did not go together.
 *
 * V9 makes it one flat menu grouped by provider: each group is labelled with
 * its key posture, each row carries the provider's hue dot and its per-Mtok
 * price, and picking a row writes provider and model together through
 * `onSelectModel` — the same single path ⌘K's `/models` corpus uses. The
 * control now sits where a switch is decided, next to the send button.
 *
 * Models are fetched on open rather than on mount: the list is only ever read
 * from this menu, and a provider that is merely configured (a stopped Ollama,
 * an unreachable self-hosted endpoint) should not be probed on every app start.
 * The fan-out is parallel with a per-provider timeout, so one unreachable
 * provider costs its group's rows and nothing else — never the whole menu.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import type { AppSettings, ModelInfo, ProviderDescriptor } from '../ipc/contracts';
import { listProviderDescriptors, listProviderModels } from '../ipc/client';
import { formatModelPriceLabel } from '../lib/costTable';
import { providerHueId } from '../lib/providerIdentity';
import { ChevronDown } from '../icons';

/**
 * How long a single provider gets to answer before its group renders empty.
 * A stopped Ollama on localhost fails fast, but a self-hosted endpoint behind a
 * dropped route hangs until the OS gives up — which is far longer than anyone
 * will hold a menu open.
 */
const MODEL_FETCH_TIMEOUT_MS = 2500;

interface ComposerModelPickerProps {
  settings: AppSettings;
  /** Write provider + model in one settings update (App.handleSelectModel). */
  onSelectModel: (providerId: string, modelId: string, defaultBaseUrl?: string | null) => void;
  disabled?: boolean;
}

export interface ComposerModelPickerHandle {
  /// Open the model switcher (used by the status line's detail popover).
  /// No-op while disabled.
  open: () => void;
}

/** The group caption's suffix: where this provider's key comes from. */
function keyPosture(descriptor: ProviderDescriptor): string {
  if (descriptor.credentialMode === 'none') return 'no key needed';
  if (descriptor.isLocal) return 'local';
  return 'keychain';
}

/**
 * The row's right-hand tail. A bundled price when we know one; otherwise a
 * posture word from the descriptor, never a guessed number.
 */
function modelTail(descriptor: ProviderDescriptor, modelId: string): string | undefined {
  const price = formatModelPriceLabel(modelId);
  if (price) return price;
  if (descriptor.credentialMode === 'none' || descriptor.isLocal) return 'local';
  if (descriptor.defaultBaseUrl) return 'self-hosted';
  return undefined;
}

/**
 * The fallback row for a provider that lists no models.
 *
 * V7's popover degraded to a free-text `Model id` input whenever the model list
 * came back empty, and its provider `<select>` listed every configured provider
 * regardless. A grouped menu built only from returned models drops both: a
 * self-hosted endpoint that implements no model-listing route becomes
 * unreachable from the composer entirely, not merely awkward. That is a
 * capability loss rather than a relocation, so the group is still rendered and
 * this row carries the typing affordance V7 had.
 */
function ModelIdRow({
  provider,
  initial,
  onCommit,
}: {
  provider: ProviderDescriptor;
  initial: string;
  onCommit: (descriptor: ProviderDescriptor, modelId: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const commit = () => {
    const next = value.trim();
    if (next) onCommit(provider, next);
  };
  return (
    <div className="menu-item menu-item-input">
      <i className="pdot" aria-hidden="true" />
      <input
        className="model-id-input"
        value={value}
        placeholder="Model id"
        aria-label={`Model id for ${provider.displayName}`}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          commit();
        }}
      />
      <button type="button" className="tail" onClick={commit} disabled={!value.trim()}>
        use
      </button>
    </div>
  );
}

/** Resolve `p`, or `fallback` if it takes longer than `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    void p
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(fallback);
      });
  });
}

export const ComposerModelPicker = forwardRef<ComposerModelPickerHandle, ComposerModelPickerProps>(
  function ComposerModelPicker({ settings, onSelectModel, disabled = false }, ref) {
    const [open, setOpen] = useState(false);
    const [providers, setProviders] = useState<ProviderDescriptor[]>([]);
    const [modelsByProvider, setModelsByProvider] = useState<Record<string, ModelInfo[]>>({});
    const [loading, setLoading] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    /** Session cache: the menu is opened repeatedly, the catalogue is stable. */
    const loadedRef = useRef(false);

    useImperativeHandle(ref, () => ({
      open: () => {
        if (!disabled) setOpen(true);
      },
    }));

    const load = useCallback(async () => {
      if (loadedRef.current) return;
      setLoading(true);
      try {
        const descriptors = await listProviderDescriptors();
        setProviders(descriptors);
        // Parallel, and each provider settles independently: one unreachable
        // endpoint must not hold the other groups behind it.
        const entries = await Promise.all(
          descriptors.map(async (d) => {
            const models = await withTimeout(
              listProviderModels(d.id),
              MODEL_FETCH_TIMEOUT_MS,
              [] as ModelInfo[],
            );
            return [d.id, models] as const;
          }),
        );
        setModelsByProvider(Object.fromEntries(entries));
        loadedRef.current = true;
      } catch {
        setProviders([]);
      } finally {
        setLoading(false);
      }
    }, []);

    useEffect(() => {
      if (open) void load();
    }, [open, load]);

    // Outside click + Escape close the menu; focus returns to the trigger.
    useEffect(() => {
      if (!open) return;
      function onPointerDown(event: PointerEvent) {
        if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
      }
      function onKeyDown(event: KeyboardEvent) {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
      document.addEventListener('pointerdown', onPointerDown);
      document.addEventListener('keydown', onKeyDown);
      return () => {
        document.removeEventListener('pointerdown', onPointerDown);
        document.removeEventListener('keydown', onKeyDown);
      };
    }, [open]);

    function pick(descriptor: ProviderDescriptor, modelId: string) {
      setOpen(false);
      onSelectModel(descriptor.id, modelId, descriptor.defaultBaseUrl);
    }

    const sortedProviders = [...providers].sort(
      (a, b) => a.tier - b.tier || a.displayName.localeCompare(b.displayName),
    );
    // Every configured provider gets a group, including ones that listed no
    // models — filtering those out would make them unselectable from here.
    const settled = !loading && providers.length > 0;

    return (
      <div className="composer-model-picker" ref={rootRef}>
        <button
          ref={triggerRef}
          className="cbtn model"
          type="button"
          title="Switch model"
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
        >
          <i className="pdot" aria-hidden="true" />
          <span className="model-label">{settings.activeModel}</span>
          <ChevronDown />
        </button>

        {open && (
          <div className="menu model-menu" data-open="true" role="menu" aria-label="Switch model">
            {settled &&
              sortedProviders.map((provider) => {
                const models = modelsByProvider[provider.id] ?? [];
                return (
                  <div key={provider.id} data-provider={providerHueId(provider.id)}>
                    <div className="menu-label">
                      {provider.displayName} · {keyPosture(provider)}
                    </div>
                    {models.length > 0 ? (
                      models.map((model) => {
                        const active =
                          provider.id === settings.activeProvider &&
                          model.id === settings.activeModel;
                        const tail = modelTail(provider, model.id);
                        return (
                          <button
                            key={model.id}
                            type="button"
                            role="menuitem"
                            className="menu-item"
                            aria-current={active || undefined}
                            onClick={() => pick(provider, model.id)}
                          >
                            <i className="pdot" aria-hidden="true" />
                            {model.displayName ?? model.id}
                            {tail && <span className="tail">{tail}</span>}
                          </button>
                        );
                      })
                    ) : (
                      <ModelIdRow
                        provider={provider}
                        initial={
                          provider.id === settings.activeProvider ? settings.activeModel : ''
                        }
                        onCommit={pick}
                      />
                    )}
                  </div>
                );
              })}

            {!settled && (
              <div className="menu-empty">
                {loading ? 'Loading models…' : 'No providers configured. Check Providers & keys.'}
              </div>
            )}
          </div>
        )}
      </div>
    );
  },
);
