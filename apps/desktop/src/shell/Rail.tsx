/// The navigation rail (ADR-011 shell): the product mark and name, then one
/// labeled button per destination, then the light/dark toggle and Settings at
/// the bottom. Chats shows the chat list and the chat; every other destination
/// is a page in the main area.
///
/// Every destination carries its label under its icon — the rail is how a
/// first-time user finds their way around, so nothing here is icon-only.
///
/// The buttons sit in groups, split by hairlines, by what they are for: making things
/// (Chats, Slides, Writing), apps (the home screen, and Manage), what runs
/// without you (Inbox, Workflows, Agents), and Context — the one place for
/// what the model knows and can use (Documents, Library, Connectors, Memory),
/// which open as tabs of a single page. Icons are outlines; the current
/// destination's turns solid inside its accent pill.
///
/// A toolbar in ARIA terms: one tab stop, arrow keys move between buttons,
/// Home/End jump to the ends. `aria-current="page"` marks where you are.

import { Fragment, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useT } from '../i18n';
import { appName } from '../brand';
import {
  AgentsIcon,
  AgentsSolidIcon,
  AppsSolidIcon,
  ChatSolidIcon,
  HomeSolidIcon,
  InboxSolidIcon,
  KnowledgeSolidIcon,
  SettingsSolidIcon,
  SlidersSolidIcon,
  SlidesSolidIcon,
  WorkflowSolidIcon,
  WritingSolidIcon,
  BrandMark,
  ChatIcon,
  ConnectorsIcon,
  HomeIcon,
  IdeaIcon,
  InboxIcon,
  KnowledgeIcon,
  MemoryIcon,
  MoonIcon,
  SettingsIcon,
  SkillIcon,
  SlidersIcon,
  SlidesIcon,
  SunIcon,
  WorkflowIcon,
  WritingIcon,
  AppsIcon,
} from '../icons';

export type Destination =
  | 'home'
  | 'chats'
  | 'slides'
  | 'writing'
  /** Apps: the home screen of your apps, to open and use them. */
  | 'apps'
  /** Manage: the apps list with details, network access and starters. */
  | 'manage'
  | 'inbox'
  | 'workflows'
  | 'agents'
  /** Context on the rail; navigating to it opens the last Context tab. */
  | 'context'
  | 'documents'
  | 'library'
  | 'connectors'
  | 'memory'
  | 'ideas'
  | 'settings';

/** The pages Context holds, in tab order. Each is still a destination of its
 *  own (deep links, Home's tiles and the palette land on the right tab). */
export const CONTEXT_TABS = ['documents', 'library', 'connectors', 'memory'] as const satisfies readonly Destination[];
export type ContextTab = (typeof CONTEXT_TABS)[number];

export function isContextTab(d: Destination): d is ContextTab {
  return (CONTEXT_TABS as readonly Destination[]).includes(d);
}

/** The rail button that stands for `d`: Context for its tabs, else `d`. */
export function railItemFor(d: Destination): Destination {
  return isContextTab(d) ? 'context' : d;
}

/** The rail's bands, top to bottom. Settings sits apart at the bottom. Ideas
 *  is not on the rail: it lives in the new-chat screen ("More ideas"). */
export const RAIL_BANDS: ReadonlyArray<{ id: string; items: readonly Destination[] }> = [
  { id: 'top', items: ['home'] },
  { id: 'make', items: ['chats', 'slides', 'writing'] },
  { id: 'apps', items: ['apps', 'manage'] },
  { id: 'automate', items: ['workflows', 'inbox', 'agents'] },
  { id: 'context', items: ['context'] },
];

/** Destinations the rail shows, in order. */
export const DESTINATIONS: readonly Destination[] = [...RAIL_BANDS.flatMap((band) => band.items), 'settings'];

const ICONS: Record<Destination, ReactNode> = {
  home: <HomeIcon />,
  chats: <ChatIcon />,
  slides: <SlidesIcon />,
  writing: <WritingIcon />,
  apps: <AppsIcon />,
  manage: <SlidersIcon />,
  inbox: <InboxIcon />,
  workflows: <WorkflowIcon />,
  agents: <AgentsIcon />,
  context: <KnowledgeIcon />,
  documents: <KnowledgeIcon />,
  library: <SkillIcon />,
  connectors: <ConnectorsIcon />,
  memory: <MemoryIcon />,
  ideas: <IdeaIcon />,
  settings: <SettingsIcon />,
};

/** The solid icon each rail button shows while it is where you are. */
const SOLID_ICONS: Partial<Record<Destination, ReactNode>> = {
  home: <HomeSolidIcon />,
  chats: <ChatSolidIcon />,
  slides: <SlidesSolidIcon />,
  writing: <WritingSolidIcon />,
  apps: <AppsSolidIcon />,
  manage: <SlidersSolidIcon />,
  inbox: <InboxSolidIcon />,
  workflows: <WorkflowSolidIcon />,
  agents: <AgentsSolidIcon />,
  context: <KnowledgeSolidIcon />,
  settings: <SettingsSolidIcon />,
};

/** Destinations whose short rail label needs a fuller accessible name. */
const ARIA_LABEL_KEYS: Partial<Record<Destination, string>> = {
  manage: 'shell.rail.manageAria',
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
  const bands = RAIL_BANDS.map((band) => ({ ...band, items: band.items.filter((d) => !hidden.includes(d)) })).filter(
    (band) => band.items.length > 0,
  );
  const bottom: Destination[] = hidden.includes('settings') ? [] : ['settings'];
  const order = [...bands.flatMap((band) => band.items), ...bottom];
  const here = railItemFor(destination);

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
    const current = d === here;
    const label = t(`shell.rail.${d}`);
    const ariaKey = ARIA_LABEL_KEYS[d];
    const name = ariaKey ? t(ariaKey) : label;
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
        aria-label={dots[d] ? t('shell.rail.withNew', { label: name }) : name}
        tabIndex={current || (!order.includes(here) && index === 0) ? 0 : -1}
        onClick={() => onNavigate(d)}
      >
        <span className="rail-icon" data-filled={current && SOLID_ICONS[d] ? '' : undefined}>
          {(current && SOLID_ICONS[d]) || ICONS[d]}
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
        {bands.map((band, i) =>
          band.id === 'top' ? (
            band.items.map(button)
          ) : (
            <Fragment key={band.id}>
              {i > 0 && <span className="rail-rule" aria-hidden="true" />}
              <div className="rail-band" data-band={band.id}>
                {band.items.map(button)}
              </div>
            </Fragment>
          ),
        )}
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
