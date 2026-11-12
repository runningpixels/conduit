import type { ConversationBrowser } from '../ipc/contracts';
import { useT } from '../i18n';
import { fitPopover } from './fitPopover';

/** What "Allow on all sites" saves to the chat's site list. */
const ANY_SITE = '*';

interface ComposerBrowserProps {
  open: boolean;
  browser: ConversationBrowser;
  /** Settings → Computer is on. Off: the ticks are disabled and the popover says why. */
  computerOn: boolean;
  /** Local-only mode: no browser, like no web. */
  localOnly: boolean;
  onClose: () => void;
  onChange: (use: boolean, act: boolean) => void;
  onClearSites?: () => void;
  onOpenComputerSettings?: () => void;
}

/** A chat's browser ticks (Browser B3): "Use the browser" and, nested under it,
 *  "Let it click and type". Per chat; they need Settings → Computer. */
export function ComposerBrowser({
  open,
  browser,
  computerOn,
  localOnly,
  onClose,
  onChange,
  onClearSites,
  onOpenComputerSettings,
}: ComposerBrowserProps) {
  const t = useT();
  if (!open) return null;

  const available = computerOn && !localOnly;
  const use = browser.use;
  const act = browser.use && browser.act;
  const anySite = browser.sites.includes(ANY_SITE);
  const named = browser.sites.filter((s) => s !== ANY_SITE);

  return (
    <div
      id="composer-browser"
      role="dialog"
      aria-label={t('chat.browser.ariaLabel')}
      className="chat-settings-pop composer-browser-pop"
      ref={fitPopover}
    >
      <p className="chat-settings-pop-lead">{t('chat.browser.intro')}</p>
      {!computerOn ? (
        <p className="chat-settings-pop-lead composer-browser-off" role="note">
          {t('chat.browser.computerOff')}
        </p>
      ) : localOnly ? (
        <p className="chat-settings-pop-lead composer-browser-off" role="note">
          {t('chat.browser.localOnly')}
        </p>
      ) : null}
      <ul className="composer-skill-list composer-browser-list">
        <li>
          <button
            className="toggle"
            type="button"
            role="switch"
            aria-pressed={use}
            aria-label={t('chat.browser.use')}
            disabled={!available}
            onClick={() => onChange(!use, use ? false : browser.act)}
          />
          <span>
            <b>{t('chat.browser.use')}</b>
            <small>{t('chat.browser.useHint')}</small>
          </span>
        </li>
        <li className="composer-browser-nested">
          <button
            className="toggle"
            type="button"
            role="switch"
            aria-pressed={act}
            aria-label={t('chat.browser.act')}
            disabled={!available || !use}
            onClick={() => onChange(true, !act)}
          />
          <span>
            <b>{t('chat.browser.act')}</b>
            <small>{t('chat.browser.actHint')}</small>
          </span>
        </li>
      </ul>
      {anySite || named.length > 0 ? (
        <div className="composer-browser-sites">
          <p className="chat-settings-pop-lead">
            {anySite ? t('chat.browser.sitesAll') : t('chat.browser.sitesNamed', { sites: named.join(', ') })}
          </p>
          {onClearSites ? (
            <button className="btn ghost" type="button" onClick={onClearSites}>
              {t('chat.browser.clearSites')}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="chat-settings-pop-actions">
        <button className="btn ghost" type="button" onClick={onClose}>
          {t('common.actions.close')}
        </button>
        {!computerOn && onOpenComputerSettings ? (
          <button
            className="btn ghost"
            type="button"
            onClick={() => {
              onClose();
              onOpenComputerSettings();
            }}
          >
            {t('chat.browser.openComputerSettings')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
