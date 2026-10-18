/// The navigation rail (ADR-011 shell): the product mark and name, then one
/// labeled button per destination, then Settings pinned at the bottom (the
/// light/dark toggle lives in the title bar). Chats shows the chat list and
/// the chat; every other destination is a page in the main area.
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
/// The destinations scroll rather than squeeze when the window is short;
/// Settings stays pinned below them. The scrollbar is hidden and a fade marks
/// an edge with more beyond it.
///
/// A toolbar in ARIA terms: one tab stop, arrow keys move between buttons,
/// Home/End jump to the ends. `aria-current="page"` marks where you are.
///
/// Phone widths (<= 720px, workspace.css): the same markup becomes a bottom tab
/// bar. CSS lays it out; JS only decides which destinations are tabs
/// (PHONE_TABS) and which live in the "More" sheet, whose open state it owns.

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from './useFocusTrap';
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
  SettingsIcon,
  SkillIcon,
  SlidersIcon,
  SlidesIcon,
  WorkflowIcon,
  WritingIcon,
  AppsIcon,
  MoonIcon,
  MoreIcon,
  SunIcon,
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

/** A destination's outline icon, as the rail shows it (the page header repeats it). */
export function destinationIcon(d: Destination): ReactNode {
  return ICONS[d];
}

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

/** The destinations that are tabs in the phone tab bar; the rest sit in More. */
export const PHONE_TABS: readonly Destination[] = ['home', 'chats', 'apps', 'inbox'];

/** The phone layout's breakpoint; mirrors `@media (max-width: 720px)` in workspace.css. */
export const PHONE_BREAKPOINT = 720;
const PHONE_QUERY = `(max-width: ${PHONE_BREAKPOINT}px)`;

/** True while the window is phone-sized. False where matchMedia is missing (tests). */
function usePhone(): boolean {
  const [phone, setPhone] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(PHONE_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(PHONE_QUERY);
    const sync = () => setPhone(mq.matches);
    sync();
    mq.addEventListener?.('change', sync);
    return () => mq.removeEventListener?.('change', sync);
  }, []);
  return phone;
}

/**
 * Shrinks any rail label whose longest word is wider than the label box, so
 * "Einstellungen" or "Configurações" stays one word instead of breaking into
 * "Einstellunge / n". Labels with spaces still wrap onto two lines first; only
 * a word that cannot fit on a line of its own is scaled, and never below 10px.
 */
export function fitRailLabels(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>('.rail-label')) {
    el.style.fontSize = '';
    const overflow = el.scrollWidth - el.clientWidth;
    if (overflow <= 0.5 || !el.clientWidth) continue;
    const size = parseFloat(getComputedStyle(el).fontSize);
    el.style.fontSize = `${Math.max(10, Math.floor(((size * el.clientWidth) / el.scrollWidth) * 10) / 10)}px`;
  }
}

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
  /** A white-label brand's logo, if one is configured. */
  logoSrc?: string;
  /** The theme in effect; with `onToggleTheme`, the phone More sheet shows a light/dark row. */
  effectiveTheme?: 'dark' | 'light';
  onToggleTheme?: () => void;
}

export function Rail({
  destination,
  onNavigate,
  dots = {},
  hidden = [],
  logoSrc,
  effectiveTheme = 'dark',
  onToggleTheme,
}: RailProps) {
  const t = useT();
  const refs = useRef(new Map<string, HTMLButtonElement | null>());
  const phone = usePhone();
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => {
    if (!phone) setMoreOpen(false);
  }, [phone]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bands = RAIL_BANDS.map((band) => ({ ...band, items: band.items.filter((d) => !hidden.includes(d)) })).filter(
    (band) => band.items.length > 0,
  );
  const bottom: Destination[] = hidden.includes('settings') ? [] : ['settings'];
  const order = [...bands.flatMap((band) => band.items), ...bottom];
  const here = railItemFor(destination);
  // Phone: four tabs and More. Everything else in `order` lives in the sheet.
  const tabs = order.filter((d) => PHONE_TABS.includes(d));
  const sheetItems = order.filter((d) => !PHONE_TABS.includes(d));
  const moreCurrent = sheetItems.includes(here);
  const moreDot = sheetItems.some((d) => dots[d]);
  // Arrow keys walk what is visible: the whole rail, or the tabs and More.
  const nav: string[] = phone ? [...tabs, 'more'] : order;
  const tabStop = phone ? (tabs.includes(here) ? here : 'more') : order.includes(here) ? here : order[0];

  // The fade at the scroll area's edges shows only where there is more to see.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const sync = () => {
      el.toggleAttribute('data-more-above', el.scrollTop > 1);
      el.toggleAttribute('data-more-below', el.scrollTop + el.clientHeight < el.scrollHeight - 1);
    };
    sync();
    el.addEventListener('scroll', sync, { passive: true });
    if (typeof ResizeObserver === 'undefined') return () => el.removeEventListener('scroll', sync);
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', sync);
      observer.disconnect();
    };
  }, []);

  // Labels are fitted again whenever their text, the font or the rail's size
  // changes (the short-window step makes them smaller).
  const navRef = useRef<HTMLElement>(null);
  const labelText = order.map((d) => t(`shell.rail.${d}`)).join('|');
  useLayoutEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const fit = () => fitRailLabels(el);
    fit();
    let live = true;
    void document.fonts?.ready.then(() => live && fit());
    if (typeof ResizeObserver === 'undefined') return () => void (live = false);
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [labelText, phone]);

  // A button focused off-screen (arrow keys, Tab) scrolls into view.
  function onFocus(event: FocusEvent<HTMLElement>) {
    (event.target as HTMLElement).scrollIntoView?.({ block: 'nearest' });
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const index = nav.indexOf((event.target as HTMLElement).dataset.destination ?? '');
    if (index < 0) return;
    let next = -1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % nav.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + nav.length) % nav.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = nav.length - 1;
    if (next < 0) return;
    event.preventDefault();
    refs.current.get(nav[next])?.focus();
  }

  const button = (d: Destination) => {
    const current = d === here;
    const label = t(`shell.rail.${d}`);
    const ariaKey = ARIA_LABEL_KEYS[d];
    const name = ariaKey ? t(ariaKey) : label;
    return (
      <button
        key={d}
        ref={(el) => {
          refs.current.set(d, el);
        }}
        type="button"
        className="rail-btn"
        data-destination={d}
        data-phone={PHONE_TABS.includes(d) ? 'tab' : 'more'}
        title={label}
        aria-current={current ? 'page' : undefined}
        aria-label={dots[d] ? t('shell.rail.withNew', { label: name }) : name}
        tabIndex={d === tabStop ? 0 : -1}
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
    <nav ref={navRef} className="rail" aria-label={t('shell.rail.ariaLabel')} onKeyDown={onKeyDown}>
      <div className="rail-brand">
        <span className="rail-brand-mark" title={appName()}>
          <BrandMark className="mark-glyph" src={logoSrc} />
        </span>
        <span className="rail-brand-name" title={appName()}>
          {appName()}
        </span>
      </div>
      <div className="rail-group" role="toolbar" aria-orientation="vertical" aria-label={t('shell.rail.ariaLabel')}>
        {/* The destinations scroll; Settings below stays pinned. */}
        <div className="rail-scroll" ref={scrollRef} onFocus={onFocus}>
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
        </div>
        {bottom.map(button)}
        {/* Phone only (CSS hides it otherwise): opens the sheet of the rest. */}
        <button
          ref={(el) => {
            refs.current.set('more', el);
          }}
          type="button"
          className="rail-btn rail-more"
          data-destination="more"
          aria-haspopup="dialog"
          aria-expanded={phone ? moreOpen : undefined}
          aria-current={phone && moreCurrent ? 'page' : undefined}
          aria-label={moreDot ? t('shell.rail.withNew', { label: t('shell.rail.more') }) : t('shell.rail.more')}
          tabIndex={tabStop === 'more' ? 0 : -1}
          onClick={() => setMoreOpen((open) => !open)}
        >
          <span className="rail-icon" data-filled={phone && moreCurrent ? '' : undefined}>
            <MoreIcon />
            {moreDot && <span className="rail-dot" aria-hidden="true" />}
          </span>
          <span className="rail-label" aria-hidden="true">
            {t('shell.rail.more')}
          </span>
        </button>
      </div>
      {phone && moreOpen && (
        <MoreSheet
          items={sheetItems}
          here={here}
          dots={dots}
          effectiveTheme={effectiveTheme}
          onToggleTheme={onToggleTheme}
          onNavigate={(d) => {
            setMoreOpen(false);
            onNavigate(d);
          }}
          onClose={() => {
            setMoreOpen(false);
            refs.current.get('more')?.focus();
          }}
        />
      )}
    </nav>
  );
}

interface MoreSheetProps {
  items: readonly Destination[];
  here: Destination;
  dots: Partial<Record<Destination, boolean>>;
  effectiveTheme: 'dark' | 'light';
  onToggleTheme?: () => void;
  onNavigate: (destination: Destination) => void;
  onClose: () => void;
}

/** The phone "More" bottom sheet: the destinations that are not tabs, then light/dark. */
function MoreSheet({ items, here, dots, effectiveTheme, onToggleTheme, onNavigate, onClose }: MoreSheetProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);
  // Rendered in a portal: the rail's own ink remap and bar geometry must not apply.
  return createPortal(
    <>
      <div className="more-scrim" aria-hidden="true" onClick={onClose} />
      <div
        ref={ref}
        className="more-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t('shell.rail.more')}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <span className="more-grip" aria-hidden="true" />
        {items.map((d) => {
          const label = t(`shell.rail.${d}`);
          const ariaKey = ARIA_LABEL_KEYS[d];
          const name = ariaKey ? t(ariaKey) : label;
          return (
            <button
              key={d}
              type="button"
              className="more-row"
              aria-current={d === here ? 'page' : undefined}
              aria-label={dots[d] ? t('shell.rail.withNew', { label: name }) : name}
              onClick={() => onNavigate(d)}
            >
              <span className="more-row-icon">
                {(d === here && SOLID_ICONS[d]) || ICONS[d]}
                {dots[d] && <span className="rail-dot" aria-hidden="true" />}
              </span>
              <span className="more-row-label">{label}</span>
            </button>
          );
        })}
        {onToggleTheme && (
          <button type="button" className="more-row more-row-theme" onClick={onToggleTheme}>
            <span className="more-row-icon">{effectiveTheme === 'light' ? <SunIcon /> : <MoonIcon />}</span>
            <span className="more-row-label">{t('workspace.mainHead.themeToggleTitle')}</span>
          </button>
        )}
      </div>
    </>,
    document.body,
  );
}
