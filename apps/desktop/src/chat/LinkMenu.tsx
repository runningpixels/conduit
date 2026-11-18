/// Right-click on a web link in a chat reply or a source list: open it in
/// your browser, in the agent's browser (to sign in or pass a check there, in
/// the profile the agent uses), or copy it. Other links keep the webview's
/// own menu.

import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { Menu } from '../workspace/Menu';
import { externalLinkFor } from '../shell/externalLinks';
import { openExternalUrl, openInAgentBrowser } from '../ipc/client';
import { translateError } from '../ipc/errors';

/** Where links get this menu: chat replies and the source lists. */
export const LINK_MENU_AREAS = '.turn.assistant, .sources-view, .research-sources';

interface Open {
  x: number;
  y: number;
  url: string;
}

export function LinkMenu({
  onStatus,
  root = document,
}: {
  onStatus?: (message: string) => void;
  root?: Document | HTMLElement;
}) {
  const t = useT();
  const [menu, setMenu] = useState<Open | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onContextMenu = (event: Event) => {
      const e = event as MouseEvent;
      const url = externalLinkFor(e.target);
      if (!url || !(e.target instanceof Element) || !e.target.closest(LINK_MENU_AREAS)) return;
      e.preventDefault();
      const anchor = e.target.closest('a');
      anchorRef.current = anchor;
      // From the keyboard (the menu key) there is no pointer: open under the link.
      if (e.clientX === 0 && e.clientY === 0 && anchor) {
        const box = anchor.getBoundingClientRect();
        setMenu({ x: box.left, y: box.bottom, url });
      } else {
        setMenu({ x: e.clientX, y: e.clientY, url });
      }
    };
    root.addEventListener('contextmenu', onContextMenu);
    return () => root.removeEventListener('contextmenu', onContextMenu);
  }, [root]);

  if (!menu) return null;
  const run = (action: () => Promise<void>) => {
    setMenu(null);
    action().catch((err: unknown) => onStatus?.(translateError(err, t)));
  };
  return (
    <Menu
      open
      onClose={() => setMenu(null)}
      triggerRef={anchorRef}
      className="menu link-menu"
      label={t('chat.linkMenu.label')}
      anchorPoint={{ x: menu.x, y: menu.y }}
      dismissOnOutsidePress
    >
      <button className="menu-item" type="button" role="menuitem" onClick={() => run(() => openExternalUrl(menu.url))}>
        {t('chat.linkMenu.open')}
      </button>
      <button className="menu-item" type="button" role="menuitem" onClick={() => run(() => openInAgentBrowser(menu.url))}>
        {t('chat.linkMenu.openInAgentBrowser')}
      </button>
      <button
        className="menu-item"
        type="button"
        role="menuitem"
        onClick={() => run(() => navigator.clipboard.writeText(menu.url))}
      >
        {t('chat.linkMenu.copy')}
      </button>
    </Menu>
  );
}
