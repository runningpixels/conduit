/// Browser tools (Browser B1/B2) as people read them: "Opened page",
/// "Clicked", never the tool id. Shared by the tool rows, the turn's step list
/// and the Activity view.
export const BROWSER_TOOL_LABEL: Record<string, string> = {
  open_page: 'chat.toolCall.browser.opened',
  read_page: 'chat.toolCall.browser.read',
  click: 'chat.toolCall.browser.clicked',
  type_text: 'chat.toolCall.browser.typed',
  choose_option: 'chat.toolCall.browser.chose',
  scroll: 'chat.toolCall.browser.scrolled',
  go_back: 'chat.toolCall.browser.wentBack',
  ask_to_sign_in: 'chat.toolCall.browser.askedSignIn',
};

/// Actions that act on a page and carry a `why` (everything but opening and reading).
export function isBrowserAction(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(BROWSER_TOOL_LABEL, name) && name !== 'open_page' && name !== 'read_page';
}

/// The message key for a browser tool's label, or undefined for any other tool.
export function browserToolLabelKey(name: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(BROWSER_TOOL_LABEL, name) ? BROWSER_TOOL_LABEL[name] : undefined;
}
