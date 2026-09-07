/**
 * Sidebar — the conversation list (V9 §4). History is no longer a mode; it is a
 * list beside the thread. Four rows: head (mark + collapse), nav (New chat,
 * Search), scrollable grouped list, footer workspace chip + menu. The footer
 * menu absorbs the V6 titlebar chips and the settings/connectors rail tabs.
 *
 * t0-5 adds pin / archive / one-level folders on this list: Pinned → Folders →
 * Recent (day groups) → Archived (collapsed). Context menu + drag onto a folder.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ConversationFolder, ConversationSummary } from '../ipc/contracts';
import { providerHueId } from '../lib/providerIdentity';
import { organizeConversations } from '../lib/conversationOrganization';
import { modShortcutHint } from '../lib/shortcuts';
import { appName } from '../brand';
import { useRichT, useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import {
  ArchiveIcon,
  BrandMark,
  ConnectorsIcon,
  FolderIcon,
  LockIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SidebarIcon,
  TrashIcon,
} from '../icons';

interface SidebarProps {
  conversations: ConversationSummary[];
  folders: ConversationFolder[];
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
  onPinConversation?: (id: string, pinned: boolean) => void;
  onArchiveConversation?: (id: string, archived: boolean) => void;
  onSetConversationFolder?: (id: string, folderId: string | null) => void;
  onCreateFolder?: (name: string) => Promise<ConversationFolder | void> | ConversationFolder | void;
  onRenameFolder?: (folderId: string, name: string) => void;
  onDeleteFolder?: (folderId: string) => void;
  /** Validated `data:image/...` brand logo URI, or omitted/undefined for the
   *  built-in wordmark glyph. See `brand/logo.ts`. */
  logoSrc?: string;
}

const DRAG_TYPE = 'text/conduit-conversation-id';

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

interface ContextMenuState {
  conversationId: string;
  x: number;
  y: number;
}

export function Sidebar({
  conversations,
  folders,
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
  onPinConversation,
  onArchiveConversation,
  onSetConversationFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  logoSrc,
}: SidebarProps) {
  const t = useT();
  const tr = useRichT();
  const fmt = useFormatters();
  const [menuOpen, setMenuOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [folderDialog, setFolderDialog] = useState<
    { mode: 'create'; moveId?: string } | { mode: 'rename'; folderId: string; name: string } | null
  >(null);
  const [folderName, setFolderName] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const contextRef = useRef<HTMLDivElement>(null);

  const closeMenu = () => setMenuOpen(false);
  const organized = organizeConversations(conversations, folders, { locale: fmt.locale, t });

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

  useEffect(() => {
    if (!menuOpen) return;
    const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
  }, [menuOpen]);

  useEffect(() => {
    if (!contextMenu) return;
    function onPointerDown(event: PointerEvent) {
      if (contextRef.current?.contains(event.target as Node)) return;
      setContextMenu(null);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setContextMenu(null);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [contextMenu]);

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

  const localOnlyLabel = t('shell.sidebar.footer.localOnly');
  const chipSub = [
    localOnly ? localOnlyLabel : undefined,
    providerCount != null ? t('shell.sidebar.footer.keyCount', { count: providerCount }) : undefined,
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

  function readDragId(event: React.DragEvent): string | null {
    return event.dataTransfer.getData(DRAG_TYPE) || null;
  }

  function allowDrop(event: React.DragEvent, target: string) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTarget(target);
  }

  function dropOnFolder(event: React.DragEvent, folderId: string) {
    event.preventDefault();
    setDropTarget(null);
    const id = readDragId(event);
    if (id) onSetConversationFolder?.(id, folderId);
  }

  function dropOnPinned(event: React.DragEvent) {
    event.preventDefault();
    setDropTarget(null);
    const id = readDragId(event);
    if (id) onPinConversation?.(id, true);
  }

  function dropOnRecent(event: React.DragEvent) {
    event.preventDefault();
    setDropTarget(null);
    const id = readDragId(event);
    if (!id) return;
    onArchiveConversation?.(id, false);
    onSetConversationFolder?.(id, null);
  }

  function dropOnArchived(event: React.DragEvent) {
    event.preventDefault();
    setDropTarget(null);
    const id = readDragId(event);
    if (id) onArchiveConversation?.(id, true);
  }

  function openContextMenu(event: React.MouseEvent, conversationId: string) {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ conversationId, x: event.clientX, y: event.clientY });
  }

  async function commitFolderDialog() {
    const name = folderName.trim();
    if (!name || !folderDialog) return;
    if (folderDialog.mode === 'create') {
      const created = await onCreateFolder?.(name);
      if (folderDialog.moveId && created && 'id' in created) {
        onSetConversationFolder?.(folderDialog.moveId, created.id);
      }
    } else {
      onRenameFolder?.(folderDialog.folderId, name);
    }
    setFolderDialog(null);
    setFolderName('');
  }

  function renderRow(row: ConversationSummary) {
    const providerId = convoProviders[row.id] ?? 'custom';
    return (
      <div
        key={row.id}
        className="convo-row"
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(DRAG_TYPE, row.id);
          event.dataTransfer.effectAllowed = 'move';
        }}
        onDragEnd={() => setDropTarget(null)}
        onContextMenu={(event) => openContextMenu(event, row.id)}
      >
        <button
          className="convo"
          type="button"
          data-provider={providerHueId(providerId)}
          aria-current={row.id === activeConversationId ? 'true' : undefined}
          title={row.displayTitle}
          onClick={() => onSelectConversation(row.id)}
        >
          <i className="convo-dot" aria-hidden="true" />
          {row.pinnedAt && !row.archivedAt ? (
            <span className="convo-flag" aria-label={t('shell.sidebar.groups.pinned')}>
              <PinIcon />
            </span>
          ) : null}
          <span className="convo-name">{row.displayTitle}</span>
          <span className="convo-meta">{fmt.timeAgoTerse(row.updatedAt)}</span>
        </button>
        {onDeleteConversation && (
          <button
            className="convo-del"
            type="button"
            aria-label={t('shell.sidebar.row.deleteAriaLabel', { title: row.displayTitle })}
            title={t('shell.sidebar.row.deleteTitle')}
            onClick={(event) => {
              event.stopPropagation();
              onDeleteConversation(row.id);
            }}
          >
            <TrashIcon />
          </button>
        )}
      </div>
    );
  }

  const contextRow = contextMenu
    ? conversations.find((row) => row.id === contextMenu.conversationId)
    : undefined;

  const showFolders = folders.length > 0 || Boolean(onCreateFolder);
  const hasList = conversations.length > 0 || folders.length > 0;

  return (
    <aside className="sidebar" aria-label={t('shell.sidebar.aria.root')}>
      <div className="sb-head sidebar-inner">
        <span className="mark">
          <BrandMark className="mark-glyph" src={logoSrc} />
          <b>{appName()}</b>
        </span>
        <button
          className="sb-collapse"
          type="button"
          aria-label={t('shell.sidebar.head.collapseAriaLabel')}
          title={t('shell.sidebar.head.collapseTitle', { shortcut: modShortcutHint('\\') })}
          onClick={onCollapse}
        >
          <SidebarIcon />
        </button>
      </div>

      <nav className="sb-nav sidebar-inner" aria-label={t('shell.sidebar.aria.nav')}>
        <button className="sb-item newchat" type="button" onClick={onNewChat}>
          <PlusIcon />
          {t('shell.sidebar.nav.newChat')}
          <kbd>{modShortcutHint('N')}</kbd>
        </button>
        <button className="sb-item" type="button" onClick={onOpenPalette}>
          <SearchIcon />
          {t('common.actions.search')}
          <kbd>{modShortcutHint('K')}</kbd>
        </button>
      </nav>

      <div className="sb-list scroll sidebar-inner">
        {!hasList ? (
          <div className="sb-empty">
            {tr('shell.sidebar.empty.noChats', { shortcut: modShortcutHint('N') })}
          </div>
        ) : (
          <>
            {organized.allArchived && (
              <div className="sb-empty">
                {t('shell.sidebar.empty.allArchived')}
              </div>
            )}

            {(organized.pinned.length > 0 || dropTarget === 'pinned') && (
              <div
                className="sb-drop"
                data-over={dropTarget === 'pinned' ? 'true' : undefined}
                onDragOver={(event) => allowDrop(event, 'pinned')}
                onDragLeave={() => setDropTarget((current) => (current === 'pinned' ? null : current))}
                onDrop={dropOnPinned}
              >
                <div className="sb-group">{t('shell.sidebar.groups.pinned')}</div>
                {organized.pinned.map(renderRow)}
              </div>
            )}

            {showFolders && (
              <div>
                <div className="sb-group sb-group-row">
                  <span>{t('shell.sidebar.groups.folders')}</span>
                  {onCreateFolder && (
                    <button
                      className="sb-group-action"
                      type="button"
                      onClick={() => {
                        setFolderName('');
                        setFolderDialog({ mode: 'create' });
                      }}
                    >
                      {t('shell.sidebar.groups.newFolder')}
                    </button>
                  )}
                </div>
                {organized.folders.map(({ folder, rows }) => {
                  const collapsed = collapsedFolders[folder.id] === true;
                  const target = `folder:${folder.id}`;
                  return (
                    <div
                      key={folder.id}
                      className="sb-folder"
                      data-over={dropTarget === target ? 'true' : undefined}
                      onDragOver={(event) => allowDrop(event, target)}
                      onDragLeave={() => setDropTarget((current) => (current === target ? null : current))}
                      onDrop={(event) => dropOnFolder(event, folder.id)}
                    >
                      <div className="sb-folder-head">
                        <button
                          className="sb-folder-toggle"
                          type="button"
                          aria-expanded={!collapsed}
                          onClick={() =>
                            setCollapsedFolders((current) => ({
                              ...current,
                              [folder.id]: !collapsed,
                            }))
                          }
                        >
                          <FolderIcon />
                          <span className="sb-folder-name">{folder.name}</span>
                          <span className="sb-folder-count">{rows.length}</span>
                        </button>
                        {onRenameFolder && (
                          <button
                            className="sb-folder-edit"
                            type="button"
                            aria-label={t('shell.sidebar.folder.renameAriaLabel', { name: folder.name })}
                            onClick={() => {
                              setFolderName(folder.name);
                              setFolderDialog({ mode: 'rename', folderId: folder.id, name: folder.name });
                            }}
                          >
                            {t('common.actions.rename')}
                          </button>
                        )}
                        {onDeleteFolder && (
                          <button
                            className="sb-folder-edit"
                            type="button"
                            aria-label={t('shell.sidebar.folder.deleteAriaLabel', { name: folder.name })}
                            onClick={() => onDeleteFolder(folder.id)}
                          >
                            {t('common.actions.delete')}
                          </button>
                        )}
                      </div>
                      {!collapsed && rows.map(renderRow)}
                    </div>
                  );
                })}
              </div>
            )}

            <div
              className="sb-drop"
              data-over={dropTarget === 'recent' ? 'true' : undefined}
              onDragOver={(event) => allowDrop(event, 'recent')}
              onDragLeave={() => setDropTarget((current) => (current === 'recent' ? null : current))}
              onDrop={dropOnRecent}
            >
              {organized.recentGroups.map(([group, rows]) => (
                <div key={group}>
                  <div className="sb-group">{group}</div>
                  {rows.map(renderRow)}
                </div>
              ))}
            </div>

            {organized.archived.length > 0 && (
              <div
                className="sb-drop"
                data-over={dropTarget === 'archived' ? 'true' : undefined}
                onDragOver={(event) => allowDrop(event, 'archived')}
                onDragLeave={() => setDropTarget((current) => (current === 'archived' ? null : current))}
                onDrop={dropOnArchived}
              >
                <button
                  className="sb-group sb-group-toggle"
                  type="button"
                  aria-expanded={archivedOpen}
                  onClick={() => setArchivedOpen((open) => !open)}
                >
                  {t('shell.sidebar.groups.archived')}
                  <span className="sb-folder-count">{organized.archived.length}</span>
                </button>
                {archivedOpen && organized.archived.map(renderRow)}
              </div>
            )}
          </>
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
            <b>{workspaceLabel ?? t('shell.sidebar.footer.workspaceFallback')}</b>
            <small>{chipSub || localOnlyLabel}</small>
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
          aria-label={t('shell.sidebar.menu.ariaLabel')}
          onKeyDown={handleMenuKeyDown}
        >
          <div className="menu-label">{t('shell.sidebar.menu.workspaceHeading')}</div>
          <MenuItem icon={<FolderIcon />} label={t('shell.sidebar.menu.revealInExplorer')} onClick={() => { closeMenu(); onRevealWorkspace(); }} />
          <div className="menu-sep" />
          <div className="menu-label">{t('shell.sidebar.menu.configureHeading')}</div>
          <MenuItem
            icon={<KeyIcon />}
            label={t('shell.sidebar.menu.providersKeys')}
            tail={providerCount != null ? String(providerCount) : undefined}
            onClick={() => openSection('providers')}
          />
          <MenuItem
            icon={<ConnectorsIcon />}
            label={t('shell.sidebar.menu.connectors')}
            tail={connectorCount != null ? String(connectorCount) : undefined}
            onClick={() => openSection('connectors')}
          />
          <MenuItem icon={<LockIcon />} label={t('shell.sidebar.menu.privacyData')} onClick={() => openSection('privacy')} />
          <MenuItem icon={<SettingsIcon />} label={t('shell.sidebar.menu.settings')} kbd={modShortcutHint(',')} onClick={() => openSection('appearance')} />
          <div className="menu-sep" />
          <MenuItem
            icon={<DiagnosticsIcon />}
            label={t('shell.sidebar.menu.exportDiagnostics')}
            onClick={() => { closeMenu(); onExportDiagnostics(); }}
          />
          <MenuItem
            icon={<TrashIcon />}
            label={t('shell.sidebar.menu.deleteAllChats')}
            danger
            onClick={() => { closeMenu(); onDeleteAllHistory(); }}
          />
        </div>
      </div>

      {contextRow && contextMenu && (
        <div
          ref={contextRef}
          className="menu convo-menu"
          data-open="true"
          role="menu"
          aria-label={t('shell.sidebar.contextMenu.ariaLabel', { title: contextRow.displayTitle })}
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          {onPinConversation && (
            <button
              className="menu-item"
              type="button"
              role="menuitem"
              onClick={() => {
                onPinConversation(contextRow.id, !contextRow.pinnedAt);
                setContextMenu(null);
              }}
            >
              <PinIcon />
              {contextRow.pinnedAt ? t('shell.sidebar.contextMenu.unpin') : t('shell.sidebar.contextMenu.pin')}
            </button>
          )}
          {onArchiveConversation && (
            <button
              className="menu-item"
              type="button"
              role="menuitem"
              onClick={() => {
                onArchiveConversation(contextRow.id, !contextRow.archivedAt);
                setContextMenu(null);
              }}
            >
              <ArchiveIcon />
              {contextRow.archivedAt ? t('shell.sidebar.contextMenu.restore') : t('shell.sidebar.contextMenu.archive')}
            </button>
          )}
          {onSetConversationFolder && folders.length > 0 && (
            <>
              <div className="menu-sep" />
              <div className="menu-label">{t('shell.sidebar.contextMenu.moveToFolder')}</div>
              {folders.map((folder) => (
                <button
                  key={folder.id}
                  className="menu-item"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onSetConversationFolder(contextRow.id, folder.id);
                    setContextMenu(null);
                  }}
                >
                  <FolderIcon />
                  {folder.name}
                </button>
              ))}
              {contextRow.folderId && (
                <button
                  className="menu-item"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onSetConversationFolder(contextRow.id, null);
                    setContextMenu(null);
                  }}
                >
                  {t('shell.sidebar.contextMenu.removeFromFolder')}
                </button>
              )}
            </>
          )}
          {onCreateFolder && (
            <button
              className="menu-item"
              type="button"
              role="menuitem"
              onClick={() => {
                setFolderName('');
                setFolderDialog({ mode: 'create', moveId: contextRow.id });
                setContextMenu(null);
              }}
            >
              <PlusIcon />
              {t('shell.sidebar.contextMenu.newFolder')}
            </button>
          )}
          {onDeleteConversation && (
            <>
              <div className="menu-sep" />
              <button
                className="menu-item danger"
                type="button"
                role="menuitem"
                onClick={() => {
                  onDeleteConversation(contextRow.id);
                  setContextMenu(null);
                }}
              >
                <TrashIcon />
                {t('common.actions.delete')}
              </button>
            </>
          )}
        </div>
      )}

      {folderDialog && (
        <div
          className="cu-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setFolderDialog(null);
          }}
        >
          <div
            className="cu-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={folderDialog.mode === 'create' ? t('shell.sidebar.folderDialog.newTitle') : t('shell.sidebar.folderDialog.renameTitle')}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 className="cu-dialog-title">
              {folderDialog.mode === 'create' ? t('shell.sidebar.folderDialog.newTitle') : t('shell.sidebar.folderDialog.renameTitle')}
            </h2>
            <div className="cu-dialog-body">
              {folderDialog.mode === 'create'
                ? t('shell.sidebar.folderDialog.newBody')
                : t('shell.sidebar.folderDialog.renameBody')}
            </div>
            <label className="cu-dialog-phrase">
              <span>{t('shell.sidebar.folderDialog.nameLabel')}</span>
              <input
                autoFocus
                type="text"
                value={folderName}
                aria-label={t('shell.sidebar.folderDialog.nameAriaLabel')}
                autoComplete="off"
                onChange={(event) => setFolderName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void commitFolderDialog();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    setFolderDialog(null);
                  }
                }}
              />
            </label>
            <div className="cu-dialog-actions">
              <button className="btn ghost" type="button" onClick={() => setFolderDialog(null)}>
                {t('common.actions.cancel')}
              </button>
              <button
                className="btn primary"
                type="button"
                disabled={!folderName.trim()}
                onClick={() => void commitFolderDialog()}
              >
                {folderDialog.mode === 'create' ? t('shell.sidebar.folderDialog.createButton') : t('common.actions.rename')}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
