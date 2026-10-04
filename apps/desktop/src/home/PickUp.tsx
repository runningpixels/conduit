/// "Pick up where you left off": recent chats, decks, drafts and apps as cards.

import { useId, type ReactNode } from 'react';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { AppTile } from '../apps/AppTile';
import { ChatIcon, SlidesIcon, WritingIcon } from '../icons';
import type { PickUpItem } from './pickUpItems';

export interface PickUpProps {
  items: PickUpItem[];
  onOpenChat: (conversationId: string) => void;
  onOpenDeck: (deckId: string) => void;
  onOpenDraft?: (draftId: string) => void;
  onOpenApp: (appId: string) => void;
}

export function PickUp({ items, onOpenChat, onOpenDeck, onOpenDraft, onOpenApp }: PickUpProps) {
  const t = useT();
  const fmt = useFormatters();
  const labelId = useId();
  if (items.length === 0) return null;
  return (
    <section className="home-section" aria-labelledby={labelId}>
      <h3 id={labelId} className="home-section-title">
        {t('home.pickUp.title')}
      </h3>
      <ul className="home-pickup">
        {items.map((item) => {
          const title = item.kind === 'chat' ? (item.title ?? t('chat.title.untitled')) : item.title;
          let eyebrow: string;
          let action: string;
          let aria: string;
          let tile: ReactNode;
          let open: () => void;
          if (item.kind === 'chat') {
            eyebrow = t('home.pickUp.kind.chat');
            action = t('home.pickUp.action.continue');
            aria = t('home.pickUp.aria.chat', { title });
            tile = <ChatIcon />;
            open = () => onOpenChat(item.id);
          } else if (item.kind === 'deck') {
            eyebrow = t('home.pickUp.kind.deck', { count: item.slideCount });
            action = item.building ? t('home.pickUp.action.build') : t('home.pickUp.action.open');
            aria = item.building ? t('home.pickUp.aria.deckBuild', { title }) : t('home.pickUp.aria.deck', { title });
            tile = <SlidesIcon />;
            open = () => onOpenDeck(item.id);
          } else if (item.kind === 'draft') {
            eyebrow = t('home.pickUp.kind.draft', { count: item.words });
            action = item.outlining ? t('home.pickUp.action.outline') : t('home.pickUp.action.continue');
            aria = item.outlining ? t('home.pickUp.aria.draftOutline', { title }) : t('home.pickUp.aria.draft', { title });
            tile = <WritingIcon />;
            open = () => onOpenDraft?.(item.id);
          } else {
            eyebrow = t('home.pickUp.kind.app');
            action = t('home.pickUp.action.open');
            aria = t('home.pickUp.aria.app', { title });
            tile = <AppTile icon={item.icon} name={item.title} category={item.category} />;
            open = () => onOpenApp(item.id);
          }
          return (
            <li key={`${item.kind}-${item.id}`} className="home-pickup-item">
              <button type="button" className="home-card home-pickup-card" aria-label={aria} onClick={open}>
                <span className="home-pickup-tile" data-kind={item.kind} aria-hidden="true">
                  {tile}
                </span>
                <span className="home-pickup-text">
                  <span className="home-pickup-eyebrow">{eyebrow}</span>
                  <span className="home-pickup-name" title={title}>
                    {title}
                  </span>
                  <span className="home-pickup-foot">
                    <span className="home-pickup-when">{fmt.timeAgo(item.when)}</span>
                    <span className="home-pickup-action">{action}</span>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
