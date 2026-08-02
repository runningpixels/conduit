import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { SearchResult } from '../ipc/contracts';

export interface CommandPaletteConversation {
  id: string;
  title: string;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onNewChat: () => void;
  onOpenHistory: () => void;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
  onToggleDocPanel?: () => void;
  conversations: CommandPaletteConversation[];
  onSelectConversation: (id: string) => void;
  /** FTS5 full-text search over messages (debounced 300ms, min 2 chars). */
  onSearchMessages?: (query: string) => Promise<SearchResult[]>;
  /** Fired when the user picks a search result. */
  onSelectSearchResult?: (result: SearchResult) => void;
}

interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
  /** Present only for FTS5 search results, so the renderer can highlight. */
  result?: SearchResult;
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

/** App command palette (Mod+K): jump to actions, conversations, and search messages. */
export function CommandPalette({
  open,
  onClose,
  onNewChat,
  onOpenHistory,
  onOpenSettings,
  onToggleTheme,
  onToggleDocPanel,
  conversations,
  onSelectConversation,
  onSearchMessages,
  onSelectSearchResult,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const items = useMemo((): PaletteItem[] => {
    const isMac =
      typeof navigator !== 'undefined' &&
      /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    const modJ = `${isMac ? '⌘' : 'Ctrl'}+J`;

    const actions: PaletteItem[] = [
      {
        id: 'new-chat',
        label: 'New chat',
        hint: 'Start a fresh conversation',
        run: () => {
          onNewChat();
          onClose();
        },
      },
      {
        id: 'history',
        label: 'Open history',
        hint: 'Browse local conversations',
        run: () => {
          onOpenHistory();
          onClose();
        },
      },
      {
        id: 'settings',
        label: 'Open settings',
        hint: 'Provider, privacy, appearance',
        run: () => {
          onOpenSettings();
          onClose();
        },
      },
      {
        id: 'theme',
        label: 'Toggle theme',
        hint: 'Switch light / dark',
        run: () => {
          onToggleTheme();
          onClose();
        },
      },
    ];

    if (onToggleDocPanel) {
      actions.push({
        id: 'toggle-doc-panel',
        label: 'Toggle artifact panel',
        hint: modJ,
        run: () => {
          onToggleDocPanel();
          onClose();
        },
      });
    }

    const convItems: PaletteItem[] = conversations.map((c) => ({
      id: `conv-${c.id}`,
      label: c.title || 'Untitled chat',
      hint: 'Open conversation',
      run: () => {
        onSelectConversation(c.id);
        onClose();
      },
    }));

    const all = [...actions, ...convItems];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        (item.hint?.toLowerCase().includes(q) ?? false),
    );
  }, [
    conversations,
    onClose,
    onNewChat,
    onOpenHistory,
    onOpenSettings,
    onSelectConversation,
    onToggleDocPanel,
    onToggleTheme,
    query,
  ]);

  // Merge palette items + search results into a single list for arrow-key
  // navigation. Search results are appended after the filtered actions/convos.
  const allItems = useMemo((): PaletteItem[] => {
    const searchItems: PaletteItem[] = results.map((r) => ({
      id: `msg-${r.messageId}`,
      label: r.snippet || '(message)',
      hint: r.conversationTitle ?? (r.role === 'user' ? 'You' : 'Assistant'),
      result: r,
      run: () => {
        onSelectSearchResult?.(r);
        onClose();
      },
    }));
    return [...items, ...searchItems];
  }, [items, results, onSelectSearchResult, onClose]);

  const handleQueryChange = (q: string) => {
    setQuery(q);
    setActiveIndex(0);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.trim().length >= 2 && onSearchMessages) {
      setSearching(true);
      debounceRef.current = setTimeout(() => {
        void onSearchMessages(q.trim())
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
      return;
    }
    setActiveIndex(0);
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (activeIndex >= allItems.length) {
      setActiveIndex(Math.max(0, allItems.length - 1));
    }
  }, [activeIndex, allItems.length]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  if (!open) return null;

  function runActive() {
    const item = allItems[activeIndex];
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
      setActiveIndex((i) => (allItems.length === 0 ? 0 : (i + 1) % allItems.length));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) => (allItems.length === 0 ? 0 : (i - 1 + allItems.length) % allItems.length));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      runActive();
    }
  }

  return (
    <div
      className="command-palette-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          type="search"
          placeholder="Search commands, conversations, and messages…"
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          aria-label="Search commands, conversations, and messages"
          autoComplete="off"
        />
        <div className="command-palette-list" role="listbox">
          {allItems.length === 0 ? (
            <div className="command-palette-item" aria-disabled="true">
              {searching ? 'Searching…' : 'No matches'}
            </div>
          ) : (
            allItems.map((item, index) => {
              const isSearch = item.result != null;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  className={`command-palette-item${index === activeIndex ? ' active' : ''}${isSearch ? ' search-result' : ''}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => item.run()}
                >
                  {isSearch ? (
                    <span
                      className="search-result-snippet"
                      dangerouslySetInnerHTML={{ __html: highlightSnippet(item.result!) }}
                    />
                  ) : (
                    item.label
                  )}
                  {item.hint && <small>{item.hint}</small>}
                </button>
              );
            })
          )}
        </div>
        <div className="command-palette-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
