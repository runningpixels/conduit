import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type {
  Artifact,
  ModelInfo,
  ProviderDescriptor,
  SearchResult,
} from '../ipc/contracts';
import { listProviderDescriptors, listProviderModels } from '../ipc/client';
import { formatSize } from '../artifacts/format';
import { ChatIcon, ChevronRight, FilesIcon, ModelIcon, SearchIcon } from '../icons';
import { providerDisplayName } from '../lib/providerIdentity';
import { formatModelPriceLabel } from '../lib/costTable';
import { modShiftShortcutHint, modShortcutHint } from '../lib/shortcuts';
import { useFocusTrap } from '../shell/useFocusTrap';

export interface CommandPaletteConversation {
  id: string;
  title: string;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onNewChat: () => void;
  /** Open the settings sheet, optionally at a section ('providers' | …). */
  onOpenSettings: (section?: string) => void;
  onToggleTheme: () => void;
  onToggleDocPanel: () => void;
  onToggleSidebar: () => void;
  onToggleWebSearch: () => void;
  onForkConversationHere: () => void;
  onEditLastUserMessage: () => void;
  onOpenChatSettings: () => void;
  onRenameChat: () => void;
  onExportDiagnostics: () => void;
  onCopyConversationAsMarkdown: () => void;
  onExportConversationMarkdown: () => void;
  onExportConversationJson: () => void;
  onDeleteChat: () => void;
  /** V7 — delete all conversation history (routes through the confirm dialog). */
  onDeleteAllHistory: () => void;
  /** Switch the active provider + model from the / models corpus.
   *  `defaultBaseUrl` seeds an unconfigured provider's endpoint; see
   *  App.handleSelectModel. */
  onSelectModel: (providerId: string, modelId: string, defaultBaseUrl?: string | null) => void;
  conversations: CommandPaletteConversation[];
  onSelectConversation: (id: string) => void;
  /** V7 — @ artifacts corpus. */
  artifacts?: Artifact[];
  onOpenArtifact?: (artifactId: string) => void;
  /** FTS5 full-text search over messages (debounced 300ms, min 2 chars). */
  onSearchMessages?: (query: string) => Promise<SearchResult[]>;
  /** Fired when the user picks a search result. */
  onSelectSearchResult?: (result: SearchResult) => void;
}

type PaletteKind = 'chat' | 'cmd' | 'file' | 'model' | 'search';

interface PaletteItem {
  id: string;
  group: string;
  kind: PaletteKind;
  label: string;
  /** Mono right-aligned tail (shortcut / size / price). */
  tail?: string;
  /** FTS snippet, rendered with <mark> highlight. */
  result?: SearchResult;
  run: () => void;
}

/** Escape HTML in a snippet so message content can't inject markup. */
function escapeSnippetHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Wrap the [matchStart, matchEnd) range of a snippet in <mark> tags. */
function highlightSnippet(result: SearchResult): string {
  const escaped = escapeSnippetHtml(result.snippet);
  const start = Math.max(0, result.matchStart);
  const end = Math.min(escaped.length, result.matchEnd);
  if (start >= end) return escaped;
  return `${escaped.slice(0, start)}<mark>${escaped.slice(start, end)}</mark>${escaped.slice(end)}`;
}

const MODE_LABEL: Record<string, string> = {
  '>': 'commands',
  '@': 'artifacts',
  '/': 'models',
};

function PaletteIcon({ kind }: { kind: PaletteKind }) {
  if (kind === 'chat') return <ChatIcon />;
  if (kind === 'cmd') return <ChevronRight />;
  if (kind === 'file') return <FilesIcon />;
  if (kind === 'model') return <ModelIcon />;
  return null;
}

/** App command palette (⌘K): prefix modes — > commands · @ artifacts ·
 *  / models — plus recent conversations and FTS message search. The power
 *  surface: every capability removed from persistent chrome lives here. */
export function CommandPalette({
  open,
  onClose,
  onNewChat,
  onOpenSettings,
  onToggleTheme,
  onToggleDocPanel,
  onToggleSidebar,
  onToggleWebSearch,
  onForkConversationHere,
  onEditLastUserMessage,
  onOpenChatSettings,
  onRenameChat,
  onExportDiagnostics,
  onCopyConversationAsMarkdown,
  onExportConversationMarkdown,
  onExportConversationJson,
  onDeleteChat,
  onDeleteAllHistory,
  onSelectModel,
  conversations,
  onSelectConversation,
  artifacts = [],
  onOpenArtifact,
  onSearchMessages,
  onSelectSearchResult,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [providers, setProviders] = useState<ProviderDescriptor[]>([]);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, ModelInfo[]>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Restore focus to the previously-focused element on close.
  const lastFocusRef = useRef<HTMLElement | null>(null);

  const prefix = /^[>@/]/.test(query) ? query[0] : '';
  const q = (prefix ? query.slice(1) : query).trim().toLowerCase();

  // Load provider descriptors + models once per open (small N) for the
  // / models corpus; also used by the workspace-chip counts in the sidebar.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const descriptors = await listProviderDescriptors();
        if (cancelled) return;
        setProviders(descriptors);
        const entries = await Promise.all(
          descriptors.map(async (d) => {
            const models = await listProviderModels(d.id).catch(() => [] as ModelInfo[]);
            return [d.id, models] as const;
          }),
        );
        if (!cancelled) setModelsByProvider(Object.fromEntries(entries));
      } catch {
        if (!cancelled) setProviders([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const commands = useMemo((): PaletteItem[] => {
    const close = () => onClose();
    return [
      { id: 'cmd-new-chat', group: 'Commands', kind: 'cmd', label: 'New chat', tail: modShortcutHint('N'), run: () => { onNewChat(); close(); } },
      { id: 'cmd-fork', group: 'Commands', kind: 'cmd', label: 'Fork conversation here', tail: modShiftShortcutHint('F'), run: () => { onForkConversationHere(); close(); } },
      { id: 'cmd-edit-last-user', group: 'Commands', kind: 'cmd', label: 'Edit last user message', run: () => { onEditLastUserMessage(); close(); } },
      { id: 'cmd-chat-settings', group: 'Commands', kind: 'cmd', label: 'Chat settings for this conversation', run: () => { onOpenChatSettings(); close(); } },
      { id: 'cmd-toggle-panel', group: 'Commands', kind: 'cmd', label: 'Toggle context panel', tail: modShortcutHint('J'), run: () => { onToggleDocPanel(); close(); } },
      { id: 'cmd-toggle-sidebar', group: 'Commands', kind: 'cmd', label: 'Toggle sidebar', tail: modShortcutHint('\\'), run: () => { onToggleSidebar(); close(); } },
      { id: 'cmd-toggle-web', group: 'Commands', kind: 'cmd', label: 'Toggle web search for this turn', tail: modShiftShortcutHint('W'), run: () => { onToggleWebSearch(); close(); } },
      { id: 'cmd-settings', group: 'Commands', kind: 'cmd', label: 'Open settings', tail: modShortcutHint(','), run: () => { onOpenSettings(); close(); } },
      { id: 'cmd-providers', group: 'Commands', kind: 'cmd', label: 'Manage providers & keys', run: () => { onOpenSettings('providers'); close(); } },
      { id: 'cmd-web-search', group: 'Commands', kind: 'cmd', label: 'Web search settings', run: () => { onOpenSettings('web-search'); close(); } },
      { id: 'cmd-workspace', group: 'Commands', kind: 'cmd', label: 'Workspace defaults', run: () => { onOpenSettings('workspace'); close(); } },
      { id: 'cmd-connectors', group: 'Commands', kind: 'cmd', label: 'Connect a service', run: () => { onOpenSettings('connectors'); close(); } },
      { id: 'cmd-about', group: 'Commands', kind: 'cmd', label: 'About', run: () => { onOpenSettings('about'); close(); } },
      { id: 'cmd-rename', group: 'Commands', kind: 'cmd', label: 'Rename this chat', run: () => { onRenameChat(); close(); } },
      { id: 'cmd-export-diag', group: 'Commands', kind: 'cmd', label: 'Export diagnostics bundle', run: () => { onExportDiagnostics(); close(); } },
      { id: 'cmd-copy-md', group: 'Commands', kind: 'cmd', label: 'Copy conversation as Markdown', run: () => { onCopyConversationAsMarkdown(); close(); } },
      { id: 'cmd-export-md', group: 'Commands', kind: 'cmd', label: 'Export conversation as Markdown…', run: () => { onExportConversationMarkdown(); close(); } },
      { id: 'cmd-export-json', group: 'Commands', kind: 'cmd', label: 'Export conversation as JSON…', run: () => { onExportConversationJson(); close(); } },
      { id: 'cmd-delete', group: 'Commands', kind: 'cmd', label: 'Delete this chat', run: () => { onDeleteChat(); close(); } },
      { id: 'cmd-delete-all', group: 'Commands', kind: 'cmd', label: 'Delete all chats…', tail: '⌫', run: () => { onDeleteAllHistory(); close(); } },
      { id: 'cmd-theme', group: 'Commands', kind: 'cmd', label: 'Toggle theme', run: () => { onToggleTheme(); close(); } },
    ];
  }, [
    onClose, onNewChat, onForkConversationHere, onEditLastUserMessage, onOpenChatSettings, onToggleDocPanel, onToggleSidebar,
    onToggleWebSearch, onOpenSettings, onRenameChat, onExportDiagnostics,
    onCopyConversationAsMarkdown, onExportConversationMarkdown, onExportConversationJson,
    onDeleteChat, onDeleteAllHistory, onToggleTheme,
  ]);

  const modelItems = useMemo((): PaletteItem[] => {
    const items: PaletteItem[] = [];
    for (const provider of providers) {
      const models = modelsByProvider[provider.id] ?? [];
      if (models.length === 0) continue;
      for (const model of models) {
        const label = `${providerDisplayName(provider.id)} / ${model.displayName ?? model.id}`;
        const tail =
          provider.credentialMode === 'none'
            ? 'local'
            : (formatModelPriceLabel(model.id) ?? undefined);
        items.push({
          id: `model-${provider.id}-${model.id}`,
          group: providerDisplayName(provider.id),
          kind: 'model',
          label,
          tail,
          run: () => {
            onSelectModel(provider.id, model.id, provider.defaultBaseUrl);
            onClose();
          },
        });
      }
    }
    return items;
  }, [providers, modelsByProvider, onSelectModel, onClose]);

  const items = useMemo((): PaletteItem[] => {
    if (prefix === '>') {
      return commands.filter((c) => c.label.toLowerCase().includes(q));
    }
    if (prefix === '@') {
      return artifacts
        .map((a) => ({
          id: `art-${a.id}`,
          group: 'Artifacts',
          kind: 'file' as const,
          label: a.title ?? a.contentPath?.split(/[\\/]/).pop() ?? 'Untitled artifact',
          tail: formatSize(a.sizeBytes, ''),
          run: () => {
            onOpenArtifact?.(a.id);
            onClose();
          },
        }))
        .filter((a) => a.label.toLowerCase().includes(q));
    }
    if (prefix === '/') {
      return modelItems.filter((m) => m.label.toLowerCase().includes(q));
    }
    // Default corpus: New chat (empty query) + recent conversations + FTS hits.
    const convItems: PaletteItem[] = conversations
      .filter((c) => (c.title || 'Untitled chat').toLowerCase().includes(q))
      .map((c) => ({
        id: `conv-${c.id}`,
        group: 'Chats',
        kind: 'chat' as const,
        label: c.title || 'Untitled chat',
        run: () => {
          onSelectConversation(c.id);
          onClose();
        },
      }));
    const searchItems: PaletteItem[] = results.map((r) => ({
      id: `msg-${r.messageId}`,
      group: 'Messages',
      kind: 'search' as const,
      label: r.snippet || '(message)',
      result: r,
      run: () => {
        onSelectSearchResult?.(r);
        onClose();
      },
    }));
    if (!q) {
      return [
        { id: 'cmd-new-chat', group: 'Chats', kind: 'cmd', label: 'New chat', tail: modShortcutHint('N'), run: () => { onNewChat(); onClose(); } },
        ...convItems,
        ...searchItems,
      ];
    }
    return [...convItems, ...searchItems];
  }, [
    prefix, q, commands, artifacts, modelItems, conversations, results,
    onClose, onNewChat, onOpenArtifact, onSelectConversation, onSelectSearchResult,
  ]);

  const handleQueryChange = (value: string) => {
    setQuery(value);
    setActiveIndex(0);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const isDefault = !/^[>@/]/.test(value);
    const qq = value.trim().length >= 2 && isDefault ? value.trim() : '';
    if (qq && onSearchMessages) {
      setSearching(true);
      debounceRef.current = setTimeout(() => {
        void onSearchMessages(qq)
          .then((next) => {
            setResults(next.slice(0, 5));
            setSearching(false);
          })
          .catch(() => {
            setResults([]);
            setSearching(false);
          });
      }, 300);
    } else {
      setResults([]);
      setSearching(false);
    }
  };

  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setSearching(false);
      setActiveIndex(0);
      if (lastFocusRef.current && document.contains(lastFocusRef.current)) {
        lastFocusRef.current.focus();
        lastFocusRef.current = null;
      }
      return;
    }
    lastFocusRef.current = document.activeElement as HTMLElement | null;
    setActiveIndex(0);
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (items.length > 0 && activeIndex >= items.length) {
      setActiveIndex(items.length - 1);
    }
  }, [activeIndex, items.length]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // V7 §9.2: Tab cannot escape the palette while it is open.
  useFocusTrap(rootRef, open);

  if (!open) return null;

  function runActive() {
    const item = items[activeIndex];
    if (item) item.run();
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((i) => (items.length === 0 ? 0 : (i + 1) % items.length));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) => (items.length === 0 ? 0 : (i - 1 + items.length) % items.length));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      runActive();
    }
  }

  const modeLabel = prefix ? MODE_LABEL[prefix] : undefined;

  return (
    <div
      ref={rootRef}
      className="scrim palette-scrim"
      data-open="true"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
      >
        <div className="pal-input">
          <SearchIcon />
          <input
            ref={inputRef}
            type="search"
            placeholder="Search chats…  >commands  @artifacts  /models"
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            aria-label="Search chats, commands, artifacts, and models"
            autoComplete="off"
            spellCheck={false}
          />
          {modeLabel ? <span className="pal-mode">{modeLabel}</span> : null}
        </div>

        <div className="pal-list scroll" role="listbox" aria-label="Results">
          {/* V9 §7's empty state is an invitation rather than a dead end. "No
              matches. Try > for commands." told the user what they had failed
              to do; this tells them what they can do next. */}
          {items.length === 0 ? (
            <div className="pal-empty" role="status">
              {searching ? 'Searching…' : 'Nothing matches. Try a different word, or start a new chat.'}
            </div>
          ) : (
            (() => {
              const rows: ReactNode[] = [];
              let lastGroup = '';
              items.forEach((item, index) => {
                if (item.group !== lastGroup) {
                  rows.push(
                    <div className="pal-group" key={`g-${item.group}`}>{item.group}</div>,
                  );
                  lastGroup = item.group;
                }
                rows.push(
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    className="pal-item"
                    data-sel={index === activeIndex}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => item.run()}
                  >
                    <PaletteIcon kind={item.kind} />
                    {item.result ? (
                      <b
                        className="pal-snippet"
                        dangerouslySetInnerHTML={{ __html: highlightSnippet(item.result) }}
                      />
                    ) : (
                      <b>{item.label}</b>
                    )}
                    {item.tail ? <span className="tail">{item.tail}</span> : null}
                  </button>,
                );
              });
              return rows;
            })()
          )}
        </div>

        <div className="pal-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>&gt;</kbd> commands</span>
          <span><kbd>@</kbd> artifacts</span>
          <span><kbd>/</kbd> models</span>
          <span style={{ marginLeft: 'auto' }}><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
