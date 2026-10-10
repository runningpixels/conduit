import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Artifact } from '../ipc/contracts';
import { ChevronDown } from '../icons';
import { useT } from '../i18n';
import { documentKindLabel } from '../lib/documentKind';

interface ArtifactSwitcherProps {
  /** The open chat's artifacts, newest first. */
  artifacts: readonly Artifact[];
  currentId: string;
  /** Trigger content. Omitted, the trigger is an icon button (the tab strip's). */
  children?: ReactNode;
  /** Accessible name for the trigger when `children` is not a readable label. */
  triggerLabel?: string;
  onSelect: (artifactId: string) => void;
  /** "All artifacts in this chat": back to the chat's list. */
  onShowAll: () => void;
}

/**
 * The panel header's way to every artifact in the chat: a button that opens a
 * listbox of them, current one selected, and a last option back to the list.
 *
 * Escape is caught in the capture phase: DocumentPanel closes the open
 * artifact on an Escape that reaches the document, and this list sits inside
 * the panel, so a bubble-phase handler would run too late.
 */
export function ArtifactSwitcher({
  artifacts,
  currentId,
  children,
  triggerLabel,
  onSelect,
  onShowAll,
}: ArtifactSwitcherProps) {
  const t = useT();
  const listId = useId();
  const [open, setOpen] = useState(false);
  // Index of the highlighted option; `artifacts.length` is "All artifacts".
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const optionCount = artifacts.length + 1;
  const currentIndex = Math.max(
    0,
    artifacts.findIndex((a) => a.id === currentId),
  );

  function openList() {
    setActive(currentIndex);
    setOpen(true);
  }

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  function choose(index: number) {
    close(true);
    if (index >= artifacts.length) {
      onShowAll();
      return;
    }
    const picked = artifacts[index];
    if (picked && picked.id !== currentId) onSelect(picked.id);
  }

  useEffect(() => {
    if (!open) return;
    listRef.current?.focus();
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    // Capture phase, handled: Escape closes the list, not the artifact.
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openList();
    }
  }

  function onListKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive((i) => (i + 1) % optionCount);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive((i) => (i - 1 + optionCount) % optionCount);
        break;
      case 'Home':
        event.preventDefault();
        setActive(0);
        break;
      case 'End':
        event.preventDefault();
        setActive(optionCount - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        choose(active);
        break;
      case 'Tab':
        close(false);
        break;
    }
  }

  const optionId = (index: number) => `${listId}-opt-${index}`;

  return (
    <div className="doc-switcher-root" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={children ? 'doc-switcher' : 'icon-btn doc-switcher-icon'}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={triggerLabel}
        title={t('workspace.documentPanel.switcher.title')}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={onTriggerKeyDown}
      >
        {children}
        <ChevronDown />
      </button>
      {open && (
        <ul
          ref={listRef}
          id={listId}
          className="menu doc-switcher-list scroll"
          data-open="true"
          role="listbox"
          tabIndex={-1}
          aria-label={t('workspace.documentPanel.chatList.ariaLabel')}
          aria-activedescendant={optionId(active)}
          onKeyDown={onListKeyDown}
        >
          {artifacts.map((artifact, index) => {
            const title = artifact.title?.trim() || t('workspace.documentPanel.untitledArtifact');
            return (
              <li
                key={artifact.id}
                id={optionId(index)}
                data-index={index}
                role="option"
                aria-selected={artifact.id === currentId}
                className={`doc-switcher-option${index === active ? ' active' : ''}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(index)}
              >
                <span className="doc-switcher-option-name" title={title}>{title}</span>
                <span className="doc-switcher-option-kind">{documentKindLabel(artifact.kind, t)}</span>
              </li>
            );
          })}
          <li
            id={optionId(artifacts.length)}
            data-index={artifacts.length}
            role="option"
            aria-selected={false}
            className={`doc-switcher-option doc-switcher-all${active === artifacts.length ? ' active' : ''}`}
            onMouseEnter={() => setActive(artifacts.length)}
            onClick={() => choose(artifacts.length)}
          >
            {t('workspace.documentPanel.switcher.all')}
          </li>
        </ul>
      )}
    </div>
  );
}
