/// The activity rail (docs/plans/ui-revamp.md): one button per destination,
/// Settings at the bottom. Chats shows the chat sidebar and the chat; every
/// other destination is a page in the main area.
///
/// A toolbar in ARIA terms: one tab stop, arrow keys move between buttons,
/// Home/End jump to the ends. `aria-current="page"` marks where you are.

import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useT } from '../i18n';
import {
  ChatIcon,
  ConnectorsIcon,
  IdeaIcon,
  KnowledgeIcon,
  MemoryIcon,
  SettingsIcon,
  SkillIcon,
} from '../icons';

export type Destination = 'chats' | 'ideas' | 'documents' | 'library' | 'connectors' | 'memory' | 'settings';

export const DESTINATIONS: readonly Destination[] = [
  'chats',
  'ideas',
  'documents',
  'library',
  'connectors',
  'memory',
  'settings',
];

const ICONS: Record<Destination, ReactNode> = {
  chats: <ChatIcon />,
  ideas: <IdeaIcon />,
  documents: <KnowledgeIcon />,
  library: <SkillIcon />,
  connectors: <ConnectorsIcon />,
  memory: <MemoryIcon />,
  settings: <SettingsIcon />,
};

export interface RailProps {
  destination: Destination;
  onNavigate: (destination: Destination) => void;
  /** Destinations with something new (the Ideas dot). */
  dots?: Partial<Record<Destination, boolean>>;
  /** Hidden destinations (e.g. memory when the feature is off). */
  hidden?: readonly Destination[];
}

export function Rail({ destination, onNavigate, dots = {}, hidden = [] }: RailProps) {
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
        title={label}
        tabIndex={current || (!order.includes(destination) && index === 0) ? 0 : -1}
        onClick={() => onNavigate(d)}
      >
        {ICONS[d]}
        <span className="rail-label" aria-hidden="true">
          {label}
        </span>
        {dots[d] && <span className="rail-dot" aria-hidden="true" />}
      </button>
    );
  };

  return (
    <nav className="rail" aria-label={t('shell.rail.ariaLabel')} onKeyDown={onKeyDown}>
      <div className="rail-group" role="toolbar" aria-orientation="vertical" aria-label={t('shell.rail.ariaLabel')}>
        {top.map(button)}
        <span className="rail-spacer" aria-hidden="true" />
        {bottom.map(button)}
      </div>
    </nav>
  );
}
