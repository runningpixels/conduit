/// The navigation rail (ADR-011 shell): the product mark and name, then one
/// labeled button per destination, then the light/dark toggle and Settings at
/// the bottom. Chats shows the chat list and the chat; every other destination
/// is a page in the main area.
///
/// Every destination carries its label under its icon — the rail is how a
/// first-time user finds their way around, so nothing here is icon-only.
///
/// A toolbar in ARIA terms: one tab stop, arrow keys move between buttons,
/// Home/End jump to the ends. `aria-current="page"` marks where you are.

import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useT } from '../i18n';
import { appName } from '../brand';
import {
  BrandMark,
  ChatIcon,
  ConnectorsIcon,
  IdeaIcon,
  KnowledgeIcon,
  MemoryIcon,
  MoonIcon,
  SettingsIcon,
  SkillIcon,
  SunIcon,
  WorkflowIcon,
} from '../icons';

export type Destination =
  | 'chats'
  | 'ideas'
  | 'documents'
  | 'library'
  | 'workflows'
  | 'connectors'
  | 'memory'
  | 'settings';

/** Destinations the rail shows, in order. Ideas is not one of them: it lives
 *  in the new-chat screen, and its page opens from there ("More ideas"). */
export const DESTINATIONS: readonly Destination[] = [
  'chats',
  'documents',
  'library',
  'workflows',
  'connectors',
  'memory',
  'settings',
];

const ICONS: Record<Destination, ReactNode> = {
  chats: <ChatIcon />,
  ideas: <IdeaIcon />,
  documents: <KnowledgeIcon />,
  library: <SkillIcon />,
  workflows: <WorkflowIcon />,
  connectors: <ConnectorsIcon />,
  memory: <MemoryIcon />,
  settings: <SettingsIcon />,
};

export interface RailProps {
  destination: Destination;
  onNavigate: (destination: Destination) => void;
  /** Destinations with something new or running (a dot on the icon). */
  dots?: Partial<Record<Destination, boolean>>;
  /** Hidden destinations (e.g. memory when the feature is off). */
  hidden?: readonly Destination[];
  effectiveTheme: 'dark' | 'light';
  onToggleTheme: () => void;
  /** A white-label brand's logo, if one is configured. */
  logoSrc?: string;
}

export function Rail({
  destination,
  onNavigate,
  dots = {},
  hidden = [],
  effectiveTheme,
  onToggleTheme,
  logoSrc,
}: RailProps) {
  const t = useT();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const shown = DESTINATIONS.filter((d) => !hidden.includes(d));
  const top = shown.filter((d) => d !== 'settings');
  const bottom = shown.filter((d) => d === 'settings');
  const order = [...top, ...bottom];

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const index = order.indexOf((event.target as HTMLElement).dataset.destination as Destination);
    if (index < 0) return;
    let next = -1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % order.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + order.length) % order.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = order.length - 1;
    if (next < 0) return;
    event.preventDefault();
    refs.current[next]?.focus();
  }

  const button = (d: Destination) => {
    const index = order.indexOf(d);
    const current = d === destination;
    const label = t(`shell.rail.${d}`);
    return (
      <button
        key={d}
        ref={(el) => {
          refs.current[index] = el;
        }}
        type="button"
        className="rail-btn"
        data-destination={d}
        aria-current={current ? 'page' : undefined}
        aria-label={dots[d] ? t('shell.rail.withNew', { label }) : label}
        tabIndex={current || (!order.includes(destination) && index === 0) ? 0 : -1}
        onClick={() => onNavigate(d)}
      >
        <span className="rail-icon">
          {ICONS[d]}
          {dots[d] && <span className="rail-dot" aria-hidden="true" />}
        </span>
        <span className="rail-label" aria-hidden="true">
          {label}
        </span>
      </button>
    );
  };

  return (
    <nav className="rail" aria-label={t('shell.rail.ariaLabel')} onKeyDown={onKeyDown}>
      <div className="rail-brand">
        <span className="rail-brand-mark">
          <BrandMark className="mark-glyph" src={logoSrc} />
        </span>
        <span className="rail-brand-name" title={appName()}>
          {appName()}
        </span>
      </div>
      <div className="rail-group" role="toolbar" aria-orientation="vertical" aria-label={t('shell.rail.ariaLabel')}>
        {top.map(button)}
        <span className="rail-spacer" aria-hidden="true" />
        {bottom.map(button)}
      </div>
      {/* Outside the toolbar: it is an action, not a destination, so it keeps
          its own tab stop rather than joining the arrow-key sequence. */}
      <button
        className="rail-theme"
        type="button"
        aria-label={t('workspace.mainHead.themeToggleAriaLabel')}
        title={t('workspace.mainHead.themeToggleTitle')}
        onClick={onToggleTheme}
      >
        {effectiveTheme === 'light' ? <SunIcon /> : <MoonIcon />}
      </button>
    </nav>
  );
}
