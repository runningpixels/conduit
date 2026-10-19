import type { Translate } from '../i18n';

/**
 * Why a computer-use request asks, in the reader's language.
 *
 * The backend sends the reason as English text (`computer::judge` and the
 * runner's file-change request). The card translates the ones it knows and
 * shows anything else as sent, so a new backend reason reads in English
 * rather than not at all. `computerReasons.test.ts` reads those Rust sources
 * and fails when a reason there has no entry here.
 */
const EXACT: Record<string, (t: Translate) => string> = {
  'It deletes files.': (t) => t('workspace.workflows.computer.reason.deletes'),
  'It changes the system or its security settings.': (t) => t('workspace.workflows.computer.reason.system'),
  'It runs something with raised permissions.': (t) => t('workspace.workflows.computer.reason.elevated'),
  'It points git at other settings or another folder.': (t) => t('workspace.workflows.computer.reason.gitElsewhere'),
  "It rewrites or deletes what's on the server.": (t) => t('workspace.workflows.computer.reason.gitRewrite'),
  "It throws away work that isn't saved in git.": (t) => t('workspace.workflows.computer.reason.gitDiscard'),
  'It runs other commands or deletes files.': (t) => t('workspace.workflows.computer.reason.findExec'),
  'It downloads and runs a package.': (t) => t('workspace.workflows.computer.reason.packageRun'),
  'It publishes a package.': (t) => t('workspace.workflows.computer.reason.publish'),
  'It writes downloaded files or sends data.': (t) => t('workspace.workflows.computer.reason.download'),
  'An argument has a line break in it.': (t) => t('workspace.workflows.computer.reason.lineBreak'),
  'It names a network path, which can send your Windows sign-in there.': (t) =>
    t('workspace.workflows.computer.reason.networkPath'),
  'The command is very long.': (t) => t('workspace.workflows.computer.reason.tooLong'),
  "It doesn't name a program.": (t) => t('workspace.workflows.computer.reason.noProgram'),
  'It runs other programs or code, so it always asks.': (t) => t('workspace.workflows.computer.reason.runner'),
  'It runs code, so it asks unless a rule names the script.': (t) =>
    t('workspace.workflows.computer.reason.interpreter'),
  "This agent read outside content first, and that can't choose commands on its own.": (t) =>
    t('workspace.workflows.computer.reason.tainted'),
  'No rule covers it.': (t) => t('workspace.workflows.computer.reason.noRule'),
  'This workflow asks before changing files.': (t) => t('workspace.workflows.computer.reason.fileChange'),
};

const DENY_WORKFLOW = /^It matches this workflow's always-ask rule “(.*)”\.$/s;
const DENY_YOURS = /^It matches your always-ask rule “(.*)”\.$/s;
const ALWAYS_ASKS = /^(.*) Commands like this always ask\.$/s;

export function translateComputerReason(reason: string, t: Translate): string {
  const exact = EXACT[reason];
  if (exact) return exact(t);
  let m = DENY_WORKFLOW.exec(reason);
  if (m) return t('workspace.workflows.computer.reason.denyWorkflow', { rule: m[1] });
  m = DENY_YOURS.exec(reason);
  if (m) return t('workspace.workflows.computer.reason.denyYours', { rule: m[1] });
  m = ALWAYS_ASKS.exec(reason);
  if (m && EXACT[m[1]]) return t('workspace.workflows.computer.reason.alwaysAsks', { reason: EXACT[m[1]](t) });
  return reason;
}

/** The English reasons translated exactly (for the drift test). */
export const KNOWN_COMPUTER_REASONS: readonly string[] = Object.keys(EXACT);
