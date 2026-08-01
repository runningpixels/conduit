import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

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
}

interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

/** App command palette (Mod+K): jump to actions and conversations. */
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
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    if (!open) {
      setQuery('');
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
    if (activeIndex >= items.length) {
      setActiveIndex(Math.max(0, items.length - 1));
    }
  }, [activeIndex, items.length]);

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
          placeholder="Search commands and conversations…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search commands"
          autoComplete="off"
        />
        <div className="command-palette-list" role="listbox">
          {items.length === 0 ? (
            <div className="command-palette-item" aria-disabled="true">
              No matches
            </div>
          ) : (
            items.map((item, index) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={`command-palette-item${index === activeIndex ? ' active' : ''}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => item.run()}
              >
                {item.label}
                {item.hint && <small>{item.hint}</small>}
              </button>
            ))
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
