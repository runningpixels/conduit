/**
 * ComposerModelPicker — the model switcher at the composer's bottom-right
 * (V9 §2.3), and Retry ▾ in a reply's actions.
 *
 * V7 put two `<select>`s behind a popover: one for provider, one for model,
 * each writing settings on change. That was two decisions and two writes for
 * what is one act — "use this model" — and it meant a cross-provider switch
 * briefly persisted a provider/model pair that did not go together. Picking a
 * row here writes provider and model together through `onSelectModel`, the
 * same single path ⌘K's `/models` corpus uses.
 *
 * The list opens as a dialog over the window rather than a menu above the
 * trigger. An aggregator like OpenRouter lists hundreds of models with long
 * names ("DeepSeek: DeepSeek V3.1 Terminus") and two prices each, and a menu
 * as wide as the trigger's corner wrapped every one of them onto three lines.
 * The dialog has room for the name, the id and the price on one row, and a
 * provider list down the side to narrow to one provider.
 *
 * Models are fetched on the first open rather than on mount: a provider that is
 * merely configured (a stopped Ollama, an unreachable self-hosted endpoint)
 * should not be probed on every app start. The catalogue is then shared by
 * every picker and kept for the session (`lib/modelCatalog`), so later opens
 * are instant; the ↻ button lists everything again. Each provider's group
 * draws as soon as it answers, so one slow provider holds back only itself.
 *
 * The search takes focus on open: type to narrow every group at once, ↓ to
 * walk the matches, Enter to take the first one.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { AppSettings, ModelInfo, ModelPrice, ProviderDescriptor } from '../ipc/contracts';
import {
  ensureModelCatalog,
  providerVisible,
  refreshModelCatalog,
  useModelCatalog,
  withTimeout,
} from '../lib/modelCatalog';
import { formatModelPriceLabel, formatPerMtokPrice } from '../lib/costTable';
import { matchesModel, matchesProvider, modelLabel, queryTerms, sortModels } from '../lib/modelOrder';
import { useModelPrices } from '../lib/useModelPrices';
import { providerHueId } from '../lib/providerIdentity';
import { CheckIcon, ChevronDown, RetryIcon } from '../icons';
import { useT, type Translate } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { useFocusTrap } from '../shell/useFocusTrap';

interface ComposerModelPickerProps {
  settings: AppSettings;
  /** Write provider + model in one settings update (App.handleSelectModel). */
  onSelectModel: (providerId: string, modelId: string, defaultBaseUrl?: string | null) => void;
  disabled?: boolean;
  /** `reply`: Retry ▾ in a reply's actions. A small arrow opens the same
   *  dialog; picking a model then retries with it rather than switching. */
  variant?: 'composer' | 'reply';
  /** The model marked as current in the list; the chat's by default. */
  current?: { provider: string; model: string };
  /** A narrow composer: the trigger names the model without its vendor
   *  prefix (`z-ai/glm-5.3-flash` → `glm-5.3-flash`), the part that tells
   *  models apart; the full id moves to the tooltip. */
  compact?: boolean;
}

/** `vendor/model` → `model`; an id with no slash is returned as is. */
export function shortModelLabel(model: string): string {
  const cut = model.lastIndexOf('/');
  return cut >= 0 && cut < model.length - 1 ? model.slice(cut + 1) : model;
}

export interface ComposerModelPickerHandle {
  /// Open the model switcher (used by the status line's detail popover).
  /// No-op while disabled.
  open: () => void;
}

/** The group caption's suffix: where this provider's key comes from. */
function keyPosture(descriptor: ProviderDescriptor, t: Translate): string {
  if (descriptor.credentialMode === 'none') return t('chat.modelPicker.keyPosture.none');
  if (descriptor.isLocal) return t('chat.modelPicker.keyPosture.local');
  return t('chat.modelPicker.keyPosture.keychain');
}

/**
 * A row's price cells, under the Input and Output column headers. Both prices
 * when one is known (override, provider listing or bundled snapshot); "Free"
 * for a model listed at 0 / 0; a posture word for a local model; a dash for a
 * cloud model nobody priced. Never a guessed number.
 */
function PriceCells({
  descriptor,
  price,
  t,
}: {
  descriptor: ProviderDescriptor;
  price: ModelPrice | undefined;
  t: Translate;
}) {
  if (price && formatModelPriceLabel(price)) {
    const input = formatPerMtokPrice(price.inputPerMtok);
    const output = formatPerMtokPrice(price.outputPerMtok);
    return (
      <>
        <span className="model-row-cost" title={t('chat.modelPicker.columns.inputTitle', { price: input })}>
          {input}
        </span>
        <span className="model-row-cost" title={t('chat.modelPicker.columns.outputTitle', { price: output })}>
          {output}
        </span>
      </>
    );
  }
  // No "self-hosted" word keyed off `defaultBaseUrl`: every cloud preset
  // (OpenRouter, Groq, xAI, …) carries one, and the genuinely self-hosted
  // `openai_compat` is `isLocal`.
  const word = price
    ? t('chat.modelPicker.free')
    : descriptor.credentialMode === 'none' || descriptor.isLocal
      ? t('chat.modelPicker.keyPosture.local')
      : '—';
  return (
    <span className="model-row-cost model-row-cost-span" title={word === '—' ? t('chat.modelPicker.noPrice') : undefined}>
      {word}
    </span>
  );
}

/**
 * The fallback row for a provider that lists no models: a self-hosted
 * endpoint with no model-listing route would otherwise be unreachable from
 * here, so its group carries a field to type the model id into.
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
  const t = useT();
  const [value, setValue] = useState(initial);
  const commit = () => {
    const next = value.trim();
    if (next) onCommit(provider, next);
  };
  return (
    <div className="model-row model-row-input">
      <i className="pdot" aria-hidden="true" />
      <input
        className="model-id-input"
        value={value}
        placeholder={t('chat.modelPicker.modelIdPlaceholder')}
        aria-label={t('chat.modelPicker.modelIdAriaLabel', { provider: provider.displayName })}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          commit();
        }}
      />
      <button type="button" className="model-id-use" onClick={commit} disabled={!value.trim()}>
        {t('chat.modelPicker.useButton')}
      </button>
    </div>
  );
}

/** Moved to the shared catalogue; re-exported for existing callers. */
export { withTimeout };

const ROW_SELECTOR = '.model-row-pick:not([disabled])';

export const ComposerModelPicker = forwardRef<ComposerModelPickerHandle, ComposerModelPickerProps>(
  function ComposerModelPicker(
    { settings, onSelectModel, disabled = false, variant = 'composer', current, compact = false },
    ref,
  ) {
    const reply = variant === 'reply';
    const currentProvider = current?.provider ?? settings.activeProvider;
    const currentModel = current?.model ?? settings.activeModel;
    const t = useT();
    const fmt = useFormatters();
    const titleId = useId();
    const [open, setOpen] = useState(false);
    const catalog = useModelCatalog();
    const providers = useMemo(() => catalog.providers ?? [], [catalog.providers]);
    const modelsByProvider = useMemo(() => {
      const out: Record<string, ModelInfo[]> = {};
      for (const [id, entry] of Object.entries(catalog.models)) {
        if (entry.state === 'ready') out[id] = entry.models;
      }
      return out;
    }, [catalog.models]);
    const lookupPrice = useModelPrices(
      useMemo(
        () =>
          Object.entries(modelsByProvider).map(([providerId, models]) => ({
            providerId,
            modelIds: models.map((m) => m.id),
          })),
        [modelsByProvider],
      ),
    );
    const [query, setQuery] = useState('');
    /** The provider the side list narrowed to; `null` shows them all. */
    const [only, setOnly] = useState<string | null>(null);
    /** Kept across opens: someone who sorts by price usually wants it again. */
    const [sort, setSort] = useState<{ key: 'name' | 'price'; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });
    /** A click on the active key flips its direction; on the other, starts it ascending. */
    const toggleSort = (key: 'name' | 'price') =>
      setSort((was) => (was.key === key ? { key, dir: was.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
    const dialogRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    useImperativeHandle(ref, () => ({
      open: () => {
        if (!disabled) setOpen(true);
      },
    }));

    useEffect(() => {
      // Cheap when the catalogue is cached: only what is missing (or a failed
      // listing old enough to try again) is fetched.
      if (open) void ensureModelCatalog(currentProvider);
      // Each opening starts from the whole catalogue, not the last search.
      else {
        setQuery('');
        setOnly(null);
      }
    }, [open]);

    const close = useCallback(() => setOpen(false), []);

    useFocusTrap(dialogRef, open);
    useEffect(() => {
      if (open) searchRef.current?.focus();
    }, [open]);

    // Escape: a search clears first, then the dialog closes. Capture phase and
    // stopped, so it never reaches the panels underneath (the document panel
    // closes its artifact on Escape).
    useEffect(() => {
      if (!open) return;
      function onKeyDown(event: globalThis.KeyboardEvent) {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        if (searchRef.current && document.activeElement === searchRef.current && searchRef.current.value) {
          setQuery('');
          return;
        }
        close();
      }
      document.addEventListener('keydown', onKeyDown, true);
      return () => document.removeEventListener('keydown', onKeyDown, true);
    }, [open, close]);

    function pick(descriptor: ProviderDescriptor, modelId: string) {
      setOpen(false);
      onSelectModel(descriptor.id, modelId, descriptor.defaultBaseUrl);
    }

    const sortedProviders = useMemo(
      () =>
        providers
          .filter((provider) => providerVisible(catalog, provider, currentProvider))
          .sort((a, b) => a.tier - b.tier || fmt.compare(a.displayName, b.displayName))
          .map((provider) => ({
            provider,
            pending: catalog.models[provider.id]?.state !== 'ready',
            models: sortModels(modelsByProvider[provider.id] ?? []),
          })),
      [providers, modelsByProvider, catalog, currentProvider, fmt],
    );

    // A search narrows every group to its matching rows; a group that lists no
    // models (the typing row) shows only when its provider name matches. A
    // group still listing shows its caption and a loading line meanwhile.
    const terms = queryTerms(query);
    const groups = sortedProviders
      .filter(({ provider }) => only === null || provider.id === only)
      .map(({ provider, pending, models }) => ({
        provider,
        pending,
        listed: models.length > 0,
        models: (sort.key === 'name' && sort.dir === 'desc' ? [...models].reverse() : models).filter((model) =>
          matchesModel(terms, provider.displayName, model),
        ),
      }))
      .filter(
        ({ provider, pending, listed, models }) =>
          models.length > 0 ||
          ((pending || !listed) && terms.every((term) => matchesProvider(term, provider.displayName))),
      );
    const loading = catalog.providers === null;
    const settled = !loading && providers.length > 0;
    const anyPending = groups.some((group) => group.pending);

    // Sorted by price, every listed model goes into one list across providers,
    // so the cheapest (or dearest) model anywhere comes first. The key is input
    // + output per million tokens. A model with no known price sorts last
    // either way; a free one (0 / 0) counts as the cheapest.
    const byPrice = sort.key === 'price';
    const priced = (() => {
      if (!byPrice) return [];
      const cost = (providerId: string, modelId: string) => {
        const price = lookupPrice(providerId, modelId)?.price;
        return price ? price.inputPerMtok + price.outputPerMtok : null;
      };
      const rows = groups.flatMap(({ provider, models }) =>
        models.map((model) => ({ provider, model, cost: cost(provider.id, model.id) })),
      );
      return rows.sort((a, b) => {
        if (a.cost === null || b.cost === null) {
          if (a.cost === b.cost) return fmt.compare(modelLabel(a.model), modelLabel(b.model));
          return a.cost === null ? 1 : -1;
        }
        return (sort.dir === 'asc' ? a.cost - b.cost : b.cost - a.cost) ||
          fmt.compare(modelLabel(a.model), modelLabel(b.model));
      });
    })();

    // A new search, filter or sort starts the list from the top.
    useEffect(() => {
      listRef.current?.scrollTo?.({ top: 0 });
    }, [query, only, sort.key, sort.dir]);

    function renderRow(provider: ProviderDescriptor, model: ModelInfo, showProvider: boolean) {
      const active = provider.id === currentProvider && model.id === currentModel;
      const label = modelLabel(model);
      // Sorted by price the rows are no longer under their provider's caption,
      // so the second line names the provider too.
      const sub = showProvider ? `${provider.displayName} · ${model.id}` : label !== model.id ? model.id : null;
      return (
        <button
          key={model.id}
          type="button"
          className="model-row model-row-pick"
          role="option"
          aria-selected={active}
          aria-current={active || undefined}
          title={model.id}
          onClick={() => pick(provider, model.id)}
        >
          <i className="pdot" aria-hidden="true" />
          <span className="model-row-text">
            <span className="model-row-name">{label}</span>
            {sub ? <span className="model-row-id">{sub}</span> : null}
          </span>
          <PriceCells descriptor={provider} price={lookupPrice(provider.id, model.id)?.price} t={t} />
          <span className="model-row-check" aria-hidden="true">
            {active ? <CheckIcon /> : null}
          </span>
        </button>
      );
    }

    // Open on the model in use: scroll it into the middle of the list once its
    // row exists. Not again while you scroll or search.
    const scrolledRef = useRef(false);
    useEffect(() => {
      if (!open) {
        scrolledRef.current = false;
        return;
      }
      if (scrolledRef.current || query) return;
      const row = listRef.current?.querySelector<HTMLElement>('.model-row-pick[aria-current="true"]');
      if (!row) return;
      scrolledRef.current = true;
      row.scrollIntoView?.({ block: 'center' });
    });

    /** ↑/↓ walk the rows; ↑ from the first row goes back to the search. */
    function onListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>(ROW_SELECTOR) ?? []);
      const at = rows.indexOf(document.activeElement as HTMLElement);
      if (at < 0) return;
      event.preventDefault();
      if (event.key === 'ArrowDown') rows[Math.min(at + 1, rows.length - 1)]?.focus();
      else if (at === 0) searchRef.current?.focus();
      else rows[at - 1]?.focus();
    }

    function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        listRef.current?.querySelector<HTMLElement>(ROW_SELECTOR)?.focus();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const first = groups.find((group) => group.models.length > 0);
        if (first) pick(first.provider, first.models[0]!.id);
      }
    }

    const title = reply ? t('chat.retryModel.title') : t('chat.modelPicker.switchModel');

    const dialog = open ? (
      <div
        className="cu-dialog-backdrop model-dialog-backdrop"
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <div
          ref={dialogRef}
          className="cu-dialog model-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
        >
          <div className="model-dialog-head">
            <h2 className="cu-dialog-title" id={titleId}>
              {title}
            </h2>
            <button
              type="button"
              className="iconbtn"
              aria-label={t('common.actions.close')}
              title={t('common.actions.close')}
              onClick={close}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>

          <div className="model-dialog-search">
            <input
              ref={searchRef}
              type="search"
              value={query}
              placeholder={t('chat.modelPicker.searchPlaceholder')}
              aria-label={t('chat.modelPicker.searchPlaceholder')}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
            />
            <div className="model-dialog-sort" role="group" aria-label={t('chat.modelPicker.sort.label')}>
              <span className="model-dialog-sort-label" aria-hidden="true">
                {t('chat.modelPicker.sort.by')}
              </span>
              {(['name', 'price'] as const).map((key) => {
                const active = sort.key === key;
                const dir = active ? sort.dir : 'asc';
                // The name says what a click does now: the order it shows when
                // active, and which way it starts when not.
                const label = t(`chat.modelPicker.sort.${key}${dir === 'asc' ? 'Asc' : 'Desc'}`);
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={active}
                    aria-label={label}
                    title={key === 'price' ? `${label}. ${t('chat.modelPicker.sort.priceTitle')}` : label}
                    onClick={() => toggleSort(key)}
                  >
                    {t(`chat.modelPicker.sort.${key}`)}
                    {active ? (
                      <svg className="model-dialog-sort-arrow" data-dir={dir} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M12 5v14M6 13l6 6 6-6" />
                      </svg>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="model-dialog-body">
            {sortedProviders.length > 1 ? (
              <div className="model-dialog-providers scroll" role="group" aria-label={t('chat.modelPicker.providersLabel')}>
                <button
                  type="button"
                  className="model-dialog-provider"
                  aria-pressed={only === null}
                  onClick={() => setOnly(null)}
                >
                  <span className="model-dialog-provider-name">{t('chat.modelPicker.allProviders')}</span>
                </button>
                {sortedProviders.map(({ provider, pending, models }) => (
                  <button
                    key={provider.id}
                    type="button"
                    className="model-dialog-provider"
                    data-provider={providerHueId(provider.id)}
                    aria-pressed={only === provider.id}
                    onClick={() => setOnly((was) => (was === provider.id ? null : provider.id))}
                  >
                    <i className="pdot" aria-hidden="true" />
                    <span className="model-dialog-provider-name">{provider.displayName}</span>
                    <span className="model-dialog-provider-count">{pending ? '…' : fmt.count(models.length)}</span>
                  </button>
                ))}
              </div>
            ) : null}

            <div className="model-dialog-main">
            {/* Column headers, outside the scroll so they stay put. The two
                prices are what a million tokens costs going in (your
                messages, files and the chat so far) and coming out (what the
                model writes); the help is on hover. */}
            <div className="model-dialog-columns scroll" aria-hidden="true">
              <span />
              <span>{t('chat.modelPicker.columns.model')}</span>
              <span className="model-dialog-col-cost" title={t('chat.modelPicker.columns.inputHelp')}>
                {t('chat.modelPicker.columns.input')}
              </span>
              <span className="model-dialog-col-cost" title={t('chat.modelPicker.columns.outputHelp')}>
                {t('chat.modelPicker.columns.output')}
              </span>
              <span />
            </div>
            <div
              className="model-dialog-list scroll"
              ref={listRef}
              role="listbox"
              aria-labelledby={titleId}
              onKeyDown={onListKeyDown}
            >
              {settled && byPrice && priced.length > 0 ? (
                <section className="model-dialog-group" role="group" aria-label={t('chat.modelPicker.sort.label')}>
                  {priced.map(({ provider, model }) => (
                    <div key={`${provider.id}:${model.id}`} data-provider={providerHueId(provider.id)}>
                      {renderRow(provider, model, true)}
                    </div>
                  ))}
                </section>
              ) : null}
              {settled &&
                groups.map(({ provider, pending, listed, models }) =>
                  // Sorted by price, the listed models are in the one list
                  // above; a group still loading, or one with only a typing
                  // row, keeps its own section below it.
                  byPrice && !pending && listed ? null : (
                  <section
                    key={provider.id}
                    className="model-dialog-group"
                    role="group"
                    aria-label={provider.displayName}
                    data-provider={providerHueId(provider.id)}
                  >
                    <h3 className="model-dialog-group-label" title={`${provider.displayName} · ${keyPosture(provider, t)}`}>
                      {provider.displayName} · {keyPosture(provider, t)}
                    </h3>
                    {pending ? (
                      <div className="menu-empty model-menu-pending">{t('chat.modelPicker.loadingModels')}</div>
                    ) : listed ? (
                      models.map((model) => renderRow(provider, model, false))
                    ) : (
                      <ModelIdRow
                        provider={provider}
                        initial={provider.id === currentProvider ? currentModel : ''}
                        onCommit={pick}
                      />
                    )}
                  </section>
                  ),
                )}

              {settled && groups.length === 0 && !anyPending && (
                <div className="menu-empty">{t('chat.modelPicker.noMatches', { query: query.trim() })}</div>
              )}

              {!settled && (
                <div className="menu-empty">
                  {loading ? t('chat.modelPicker.loadingModels') : t('chat.modelPicker.noProviders')}
                </div>
              )}
            </div>
            </div>
          </div>

          {/* What the two prices mean, said once for the whole list, and the
              refresh with its words: the list is cached for the session, so
              this is how a new model or a newly started server shows up. */}
          <div className="model-dialog-foot">
            <p className="model-dialog-note">{t('chat.modelPicker.priceNote')}</p>
            <button
              type="button"
              className="model-dialog-refresh"
              title={t('chat.modelPicker.refresh')}
              disabled={catalog.refreshing}
              data-busy={catalog.refreshing || undefined}
              onClick={() => void refreshModelCatalog(currentProvider)}
            >
              <RetryIcon />
              <span>{catalog.refreshing ? t('chat.modelPicker.refreshing') : t('chat.modelPicker.refreshButton')}</span>
            </button>
          </div>
        </div>
      </div>
    ) : null;

    return (
      <div className="composer-model-picker">
        {reply ? (
          <button
            className="act retry-model"
            type="button"
            title={t('chat.retryModel.title')}
            aria-label={t('chat.retryModel.title')}
            aria-haspopup="dialog"
            aria-expanded={open}
            disabled={disabled}
            onClick={() => setOpen(true)}
          >
            <ChevronDown />
          </button>
        ) : (
          <button
            className={compact ? 'cbtn model compact' : 'cbtn model'}
            type="button"
            title={compact ? settings.activeModel : t('chat.modelPicker.switchModel')}
            aria-haspopup="dialog"
            aria-expanded={open}
            disabled={disabled}
            onClick={() => setOpen(true)}
          >
            <i className="pdot" aria-hidden="true" />
            <span className="model-label">{compact ? shortModelLabel(settings.activeModel) : settings.activeModel}</span>
            <ChevronDown />
          </button>
        )}
        {/* Portalled: the composer sits inside containers that clip and
            contain layout, which would trap a fixed backdrop inside them. */}
        {dialog ? createPortal(dialog, document.body) : null}
      </div>
    );
  },
);
