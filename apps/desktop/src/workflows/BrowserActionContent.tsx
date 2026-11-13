/// The parts of a browser approval that a workflow's card and a chat's inline
/// card share (Browser B2/B3): what the agent says it is for, the action in
/// plain words, the full text it would type, the page it is on and one chip
/// saying why it asks; and the buttons. A form submit or a money-and-accounts
/// word makes "Don’t" the main button; "Always on <site>" is offered only for
/// the first action on a site (`request.offerSite`), next to "Allow on all sites".

import type { Translate } from '../i18n';
import type { BrowserRemember, BrowserRequest } from '../ipc/contracts';

/// The run-details label for each action ("Clicked"), shared with the chat's tool rows.
const DONE_LABEL: Record<string, string> = {
  click: 'chat.toolCall.browser.clicked',
  type_text: 'chat.toolCall.browser.typed',
  choose_option: 'chat.toolCall.browser.chose',
  scroll: 'chat.toolCall.browser.scrolled',
  go_back: 'chat.toolCall.browser.wentBack',
  ask_to_sign_in: 'chat.toolCall.browser.askedSignIn',
  open_page: 'chat.toolCall.browser.opened',
  read_page: 'chat.toolCall.browser.read',
};

/// Most earlier actions shown in "So far".
const SO_FAR_MAX = 4;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/// What the action does, in plain words ("Click “Place order” (button)").
/// Element roles the card can name in the person's language; any other role
/// is left out ("Click “Search”") rather than shown in English.
const ROLE_KEY: Record<string, string> = {
  link: 'workspace.workflows.browser.role.link',
  button: 'workspace.workflows.browser.role.button',
  textbox: 'workspace.workflows.browser.role.textbox',
  searchbox: 'workspace.workflows.browser.role.searchbox',
  combobox: 'workspace.workflows.browser.role.combobox',
  checkbox: 'workspace.workflows.browser.role.checkbox',
  radio: 'workspace.workflows.browser.role.radio',
  tab: 'workspace.workflows.browser.role.tab',
  menuitem: 'workspace.workflows.browser.role.menuitem',
  option: 'workspace.workflows.browser.role.option',
  switch: 'workspace.workflows.browser.role.switch',
};

function roleText(role: string | undefined, t: Translate): string | undefined {
  return role && Object.prototype.hasOwnProperty.call(ROLE_KEY, role) ? t(ROLE_KEY[role]) : undefined;
}

export function browserActionText(request: BrowserRequest, t: Translate): string {
  const name = text(request.elementName);
  const role = roleText(text(request.elementRole), t);
  switch (request.action) {
    case 'click':
      if (name && role) return t('workspace.workflows.browser.do.click', { name, role });
      if (name) return t('workspace.workflows.browser.do.clickName', { name });
      return t('workspace.workflows.browser.do.clickPlain');
    case 'type_text':
      if (name && role) return t('workspace.workflows.browser.do.type', { name, role });
      if (name) return t('workspace.workflows.browser.do.typeName', { name });
      return t('workspace.workflows.browser.do.typePlain');
    case 'choose_option':
      return name
        ? t('workspace.workflows.browser.do.choose', { option: request.option ?? '', name })
        : t('workspace.workflows.browser.do.choosePlain', { option: request.option ?? '' });
    case 'scroll':
      return t('workspace.workflows.browser.do.scroll');
    case 'go_back':
      return t('workspace.workflows.browser.do.goBack');
    default:
      return request.action;
  }
}

/// Why it asks, as the chip says it.
function reasonText(request: BrowserRequest, t: Translate, inChat: boolean): string {
  switch (request.reason) {
    case 'submit':
      return t('workspace.workflows.browser.reason.submit');
    case 'risky':
      return request.riskyWord
        ? t('workspace.workflows.browser.reason.risky', { word: request.riskyWord })
        : t('workspace.workflows.browser.reason.riskyPlain');
    case 'newSite':
      return inChat
        ? t('chat.browser.reason.newSite', { host: request.host })
        : t('workspace.workflows.browser.reason.newSite', { host: request.host });
    default:
      return '';
  }
}

/// A submit or a money-and-accounts word: the card leads with Don't.
export function browserRequestCareful(request: BrowserRequest): boolean {
  return request.reason === 'submit' || request.reason === 'risky';
}

/// An address as people read it: percent-escapes decoded (Wikipédia, not Wikip%C3%A9dia).
function readableUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}

/// One earlier action, from whatever shape the backend sent ("Clicked “Search”").
function soFarItem(entry: unknown, t: Translate): string | null {
  if (typeof entry === 'string') return text(entry) ?? null;
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  const action = text(e.action) ?? text(e.tool);
  const label = action && Object.prototype.hasOwnProperty.call(DONE_LABEL, action) ? t(DONE_LABEL[action]) : action;
  const what = text(e.elementName) ?? text(e.element) ?? text(e.name) ?? text(e.option) ?? readableUrl(text(e.url)) ?? text(e.host);
  const parts = [label, what ? `“${what}”` : undefined].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(' ') : null;
}

/// The last few earlier actions, joined ("Clicked “Search” · Typed “tauri”"), or "".
export function browserSoFarText(request: BrowserRequest, t: Translate): string {
  return (request.soFar ?? [])
    .map((entry) => soFarItem(entry, t))
    .filter((s): s is string => s !== null)
    .slice(-SO_FAR_MAX)
    .join(' · ');
}

/// The headline, the action, the typed text, the page, the reason chip and
/// what was read before. `headingId` labels the surrounding group.
export function BrowserActionDetails({
  request,
  headingId,
  t,
  inChat = false,
}: {
  request: BrowserRequest;
  headingId: string;
  t: Translate;
  /** A chat's card: "in this chat" rather than "in this workflow". */
  inChat?: boolean;
}) {
  const careful = browserRequestCareful(request);
  const title = text(request.pageTitle);
  return (
    <>
      <b id={headingId} className="cc-headline">
        {text(request.why) ?? t('workspace.workflows.browser.title')}
      </b>
      <p className="approval-sentence">{browserActionText(request, t)}</p>
      {request.action === 'type_text' && request.text !== undefined ? (
        <pre className="cc-term" aria-label={t('workspace.workflows.browser.textLabel')}>
          {request.text}
        </pre>
      ) : null}
      <p className="wf-muted" title={request.pageUrl}>
        {title
          ? t('workspace.workflows.browser.page', { title, host: request.host })
          : t('workspace.workflows.browser.pageHost', { host: request.host })}
      </p>
      <p className={`cc-chip${careful ? ' warn' : ''}`} role="note">
        {reasonText(request, t, inChat)}
      </p>
      {text(request.readBefore) ? (
        <p className="wf-muted">{t('workspace.workflows.browser.readBefore', { what: text(request.readBefore) ?? '' })}</p>
      ) : null}
    </>
  );
}

/// Do it / Don't, plus "Always on <site>" and "Allow on all sites" when the
/// request offers its site. `onAnswer(send, remember)`.
export function BrowserActionButtons({
  request,
  sending,
  onAnswer,
  t,
  className = 'wf-offer-actions',
}: {
  request: BrowserRequest;
  sending: boolean;
  onAnswer: (send: boolean, remember?: BrowserRemember) => void;
  t: Translate;
  className?: string;
}) {
  const careful = browserRequestCareful(request);
  const offerSite = text(request.offerSite);
  const doIt = t('workspace.workflows.browser.doIt');
  const dont = t('workspace.workflows.browser.dont');
  const siteButtons = offerSite ? (
    <>
      <button type="button" className="btn" disabled={sending} onClick={() => onAnswer(true, 'site')}>
        {t('workspace.workflows.browser.always', { site: offerSite })}
      </button>
      <button type="button" className="btn" disabled={sending} onClick={() => onAnswer(true, 'all')}>
        {t('workspace.workflows.browser.allowAll')}
      </button>
    </>
  ) : null;
  return (
    <div className={className}>
      {careful ? (
        <>
          <button type="button" className="btn primary" disabled={sending} onClick={() => onAnswer(false)}>
            {dont}
          </button>
          <button type="button" className="btn" disabled={sending} onClick={() => onAnswer(true)}>
            {doIt}
          </button>
          {siteButtons}
        </>
      ) : (
        <>
          <button type="button" className="btn primary" disabled={sending} onClick={() => onAnswer(true)}>
            {doIt}
          </button>
          {siteButtons}
          <button type="button" className="btn ghost" disabled={sending} onClick={() => onAnswer(false)}>
            {dont}
          </button>
        </>
      )}
    </div>
  );
}
