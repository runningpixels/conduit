/**
 * Sidebar — the conversation list (V9 §4). History is no longer a mode; it is a
 * list beside the thread. Four rows: head (mark + collapse), nav (New chat,
 * Search), scrollable grouped list, footer workspace chip + menu. The footer
 * menu absorbs the V6 titlebar chips and the settings/connectors rail tabs.
 *
 * V9 deleted the top bar, which makes this the only persistent chrome in the
 * product. Two things moved in as a result: the brand mark, and Search — the
 * `.omni` pill's capability, which was always just a second door to the ⌘K
 * palette. The head carries the window drag region alongside the title strip's.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ConversationSummary } from '../ipc/contracts';
import { providerHueId } from '../lib/providerIdentity';
import { conversationGroup } from '../lib/dayGroup';
import { modShortcutHint } from '../lib/shortcuts';
import {
  BrandMark,
  ConnectorsIcon,
  FolderIcon,
  LockIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SidebarIcon,
  TrashIcon,
} from '../icons';

interface SidebarProps {
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  /** conversationId → providerId, for the row's last-used-provider dot. */
  convoProviders: Record<string, string>;
  /** Optional workspace path label for the footer chip. */
  workspaceLabel?: string;
  localOnly?: boolean;
  providerCount?: number;
  connectorCount?: number;
  onSelectConversation: (id: string) => void;
  onNewChat: () => void;
  /** Open the ⌘K palette — the `.omni` pill's former job (V9 §2.1). */
  onOpenPalette: () => void;
  /** Collapse the sidebar; the floating reveal button brings it back. */
  onCollapse: () => void;
  onRevealWorkspace: () => void;
  onOpenSettings: (section: string) => void;
  /** Export a redacted diagnostics bundle (workspace menu). */
  onExportDiagnostics: () => void;
  /** Delete one conversation (routes through the confirm dialog). Omit to
   *  render the list without per-row delete affordances. */
  onDeleteConversation?: (id: string) => void;
  /** Delete all conversation history (routes through the confirm dialog). */
  onDeleteAllHistory: () => void;
}

/** "2m" relative label, hover-only per §8.2. */
function relativeFromIso(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(then).toLocaleDateString();
}

/** Ordered [group, rows] buckets, newest first. */
function groupConversations(
  rows: ConversationSummary[],
): [string, ConversationSummary[]][] {
  const sorted = [...rows].sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
  const buckets = new Map<string, ConversationSummary[]>();
  for (const row of sorted) {
    const group = conversationGroup(row.updatedAt);
    const list = buckets.get(group) ?? [];
    list.push(row);
    buckets.set(group, list);
  }
  return Array.from(buckets.entries());
}

function KeyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
      <path d="M7 8h10M7 12h10M7 16h6" />
      <rect x="3" y="4" width="18" height="16" rx="2" />
    </svg>
  );
}

function DiagnosticsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
      <path d="M12 8v5m0 3h.01" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

function WorkspaceGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
      <path d="M3 7.5 12 3l9 4.5-9 4.5-9-4.5Z" />
      <path d="m3 12 9 4.5L21 12M3 16.5 12 21l9-4.5" />
    </svg>
  );
}

export function Sidebar({
  conversations,
  activeConversationId,
  convoProviders,
  workspaceLabel,
  localOnly = true,
  providerCount,
  connectorCount,
  onSelectConversation,
  onNewChat,
  onOpenPalette,
  onCollapse,
  onRevealWorkspace,
  onOpenSettings,
  onExportDiagnostics,
  onDeleteConversation,
  onDeleteAllHistory,
}: SidebarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);

  const closeMenu = () => setMenuOpen(false);

  // Outside click + Escape close the workspace menu; focus returns to the chip.
  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || chipRef.current?.contains(target)) return;
      closeMenu();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu();
        chipRef.current?.focus();
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  // Focus the first item when the menu opens.
  useEffect(() => {
    if (!menuOpen) return;
    const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
  }, [menuOpen]);

  // F-12 — arrow-key navigation within the workspace menu.
  function handleMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [],
    );
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(index + 1) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1]?.focus();
    }
  }

  function openSection(section: string) {
    closeMenu();
    onOpenSettings(section);
  }

  const groups = groupConversations(conversations);
  const chipSub = [
    localOnly ? 'local only' : undefined,
    providerCount != null ? `${providerCount} key${providerCount === 1 ? '' : 's'}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  function MenuItem({
    icon,
    label,
    tail,
    kbd,
    danger,
    onClick,
  }: {
    icon: ReactNode;
    label: string;
    tail?: string;
    kbd?: string;
    danger?: boolean;
    onClick: () => void;
  }) {
    return (
      <button
        className={`menu-item${danger ? ' danger' : ''}`}
        type="button"
        role="menuitem"
        onClick={onClick}
      >
        {icon}
        {label}
        {kbd ? <kbd>{kbd}</kbd> : null}
        {tail ? <span className="tail">{tail}</span> : null}
      </button>
    );
  }

  return (
    <aside className="sidebar" aria-label="Conversations">
      {/* Not a drag region: the caption row above owns moving the window. This
          was one while the app had no top bar, which meant every non-interactive
          child needed the attribute repeated onto it — Tauri hit-tests the
          element under the cursor rather than walking up to an ancestor. */}
      <div className="sb-head sidebar-inner">
        <span className="mark">
          <BrandMark className="mark-glyph" />
          <b>Conduit</b>
        </span>
        <button
          className="sb-collapse"
          type="button"
          aria-label="Collapse sidebar"
          title={`Collapse sidebar  ${modShortcutHint('\\')}`}
          onClick={onCollapse}
        >
          <SidebarIcon />
        </button>
      </div>

      <nav className="sb-nav sidebar-inner" aria-label="Chats">
        <button className="sb-item newchat" type="button" onClick={onNewChat}>
          <PlusIcon />
          New chat
          <kbd>{modShortcutHint('N')}</kbd>
        </button>
        <button className="sb-item" type="button" onClick={onOpenPalette}>
          <SearchIcon />
          Search
          <kbd>{modShortcutHint('K')}</kbd>
        </button>
      </nav>

      <div className="sb-list scroll sidebar-inner">
        {conversations.length === 0 ? (
          <div className="sb-empty">
            No chats yet. <kbd>{modShortcutHint('N')}</kbd> starts one.
          </div>
        ) : (
          groups.map(([group, rows]) => (
            <div key={group}>
              <div className="sb-group">{group}</div>
              {rows.map((row) => {
                const providerId = convoProviders[row.id] ?? 'custom';
                // The row is a wrapper, not a button, because delete has to be
                // its own control — a button inside a button is invalid markup
                // and screen readers only announce the outer one.
                return (
                  <div key={row.id} className="convo-row">
                    <button
                      className="convo"
                      type="button"
                      data-provider={providerHueId(providerId)}
                      aria-current={row.id === activeConversationId ? 'true' : undefined}
                      title={row.displayTitle}
                      onClick={() => onSelectConversation(row.id)}
                    >
                      <i className="convo-dot" aria-hidden="true" />
                      <span className="convo-name">{row.displayTitle}</span>
                      <span className="convo-meta">{relativeFromIso(row.updatedAt)}</span>
                    </button>
                    {onDeleteConversation && (
                      <button
                        className="convo-del"
                        type="button"
                        // Named, not just "Delete": the button is one of many
                        // identical glyphs in a list, so the label has to say
                        // which row it belongs to.
                        aria-label={`Delete ${row.displayTitle}`}
                        title="Delete chat"
                        onClick={(event) => {
                          // Without this the click reaches the row underneath
                          // and selects the chat on its way to the dialog.
                          event.stopPropagation();
                          onDeleteConversation(row.id);
                        }}
                      >
                        <TrashIcon />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      <div className="sb-foot sidebar-inner">
        <button
          ref={chipRef}
          className="wschip"
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((current) => !current)}
        >
          <span className="wschip-glyph">
            <WorkspaceGlyph />
          </span>
          <span className="wschip-text">
            <b>{workspaceLabel ?? 'workspace'}</b>
            <small>{chipSub || 'local only'}</small>
          </span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
            <path d="m7 15 5-5 5 5" />
          </svg>
        </button>

        <div
          ref={menuRef}
          className="menu ws-menu"
          data-open={menuOpen ? 'true' : 'false'}
          role="menu"
          aria-label="Workspace"
          onKeyDown={handleMenuKeyDown}
        >
          <div className="menu-label">Workspace</div>
          <MenuItem icon={<FolderIcon />} label="Reveal in Explorer" onClick={() => { closeMenu(); onRevealWorkspace(); }} />
          <div className="menu-sep" />
          <div className="menu-label">Configure</div>
          <MenuItem
            icon={<KeyIcon />}
            label="Providers &amp; keys"
            tail={providerCount != null ? String(providerCount) : undefined}
            onClick={() => openSection('providers')}
          />
          <MenuItem
            icon={<ConnectorsIcon />}
            label="Connectors"
            tail={connectorCount != null ? String(connectorCount) : undefined}
            onClick={() => openSection('connectors')}
          />
          <MenuItem icon={<LockIcon />} label="Privacy &amp; data" onClick={() => openSection('privacy')} />
          <MenuItem icon={<SettingsIcon />} label="Settings" kbd={modShortcutHint(',')} onClick={() => openSection('appearance')} />
          <div className="menu-sep" />
          <MenuItem
            icon={<DiagnosticsIcon />}
            label="Export diagnostics"
            onClick={() => { closeMenu(); onExportDiagnostics(); }}
          />
          <MenuItem
            icon={<TrashIcon />}
            label="Delete all chats"
            danger
            onClick={() => { closeMenu(); onDeleteAllHistory(); }}
          />
        </div>
      </div>
    </aside>
  );
}
