/// One plain-language sentence for every tool approval ("Run “npm test” in
/// ferry", "Write report.md (2.1 KB) in Documents").
///
/// Every approval surface (the chat connector-tool prompt, the workflow action
/// card, the workflow computer card) builds its sentence here, so the wording
/// cannot drift between them. It is deterministic: the sentence comes from the
/// kind of tool and its typed arguments, never from a model call. The facts
/// already reach the renderer as data (Rust sends facts, not English), so the
/// sentence is composed here and translated with the catalog, not in Rust.
///
/// It never throws. Anything missing or odd falls back to the generic sentence.

import type { ComputerRequest } from '../ipc/contracts';
import type { Translate } from '../i18n';

/** Marked by the app or the connector: shown plainly in the sentence. */
export type ApprovalFlag = 'risky' | 'sensitive';

export type ApprovalSubject =
  | {
      kind: 'run_command';
      program?: unknown;
      args?: unknown;
      /** The workflow folder. */
      folder?: unknown;
      /** Where inside the folder it runs ('.' = the folder). */
      path?: unknown;
      flag?: ApprovalFlag;
    }
  | {
      kind: 'write_file' | 'edit_file';
      /** The file, relative to the folder. */
      path?: unknown;
      folder?: unknown;
      /** The new content (its size is shown for a write). */
      content?: unknown;
      /** The old content, when the file exists. */
      previous?: unknown;
      flag?: ApprovalFlag;
    }
  | {
      /** A connector (MCP) tool, or any tool described only by its name. */
      kind: 'tool';
      tool?: unknown;
      connector?: unknown;
      flag?: ApprovalFlag;
    };

/** Longest command text shown before it is cut. */
export const APPROVAL_COMMAND_MAX_CHARS = 80;
/** Longest file, folder or tool name shown before it is cut. */
export const APPROVAL_NAME_MAX_CHARS = 48;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** One line, cut at `max` characters with an ellipsis at the end. */
function clip(value: string, max: number): string {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** A path cut at the start, so the file name at its end stays visible. */
function clipPath(value: string, max: number): string {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `…${line.slice(line.length - (max - 1))}`;
}

function lastSegment(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
}

/** The program's file name without a Windows executable extension. */
function programName(program: string): string {
  return lastSegment(program).replace(/\.(exe|cmd|bat)$/i, '');
}

function quoteArg(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

/** The folder's name and where inside it ("ferry", "ferry/src"); '' when unknown. */
function whereOf(folder: unknown, inner: unknown): string {
  const name = lastSegment(text(folder));
  const sub = text(inner).replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '');
  const place = sub === '' || sub === '.' ? name : name ? `${name}/${sub}` : sub;
  return clipPath(place, APPROVAL_NAME_MAX_CHARS);
}

function flagOf(flag: ApprovalFlag | undefined): ApprovalFlag | 'none' {
  return flag === 'risky' || flag === 'sensitive' ? flag : 'none';
}

function genericSentence(t: Translate): string {
  return t('consent.sentence.generic');
}

function toolSentence(subject: Extract<ApprovalSubject, { kind: 'tool' }>, t: Translate): string {
  const tool = clip(text(subject.tool), APPROVAL_NAME_MAX_CHARS);
  if (!tool) return genericSentence(t);
  const connector = clip(text(subject.connector), APPROVAL_NAME_MAX_CHARS);
  const flag = flagOf(subject.flag);
  return connector
    ? t('consent.sentence.tool', { tool, connector, flag })
    : t('consent.sentence.toolNoConnector', { tool, flag });
}

function commandSentence(subject: Extract<ApprovalSubject, { kind: 'run_command' }>, t: Translate): string {
  const program = programName(text(subject.program));
  if (!program) return genericSentence(t);
  const args = Array.isArray(subject.args) ? subject.args.filter((a): a is string => typeof a === 'string') : [];
  const command = clip([program, ...args.map(quoteArg)].join(' '), APPROVAL_COMMAND_MAX_CHARS);
  const where = whereOf(subject.folder, subject.path) || t('consent.sentence.thisFolder');
  return t('consent.sentence.runCommand', { command, where, flag: flagOf(subject.flag) });
}

function fileSentence(
  subject: Extract<ApprovalSubject, { kind: 'write_file' | 'edit_file' }>,
  t: Translate,
  size: (bytes: number) => string,
): string {
  const path = text(subject.path);
  if (!path) return genericSentence(t);
  const file = clipPath(path.replace(/\\/g, '/'), APPROVAL_NAME_MAX_CHARS);
  // The file sits in the folder; its own directory is part of `file`.
  const where = whereOf(subject.folder, '') || t('consent.sentence.thisFolder');
  const flag = flagOf(subject.flag);
  if (subject.kind === 'edit_file') return t('consent.sentence.editFile', { file, where, flag });
  if (typeof subject.content !== 'string') return t('consent.sentence.editFile', { file, where, flag });
  const bytes = size(new TextEncoder().encode(subject.content).length);
  const key = typeof subject.previous === 'string' ? 'consent.sentence.replaceFile' : 'consent.sentence.writeFile';
  return t(key, { file, size: bytes, where, flag });
}

/**
 * The sentence for one approval: what will happen, in the user's language.
 * `size` formats a byte count the way the rest of the UI does (`fmt.size`).
 */
export function describeApproval(
  subject: ApprovalSubject,
  t: Translate,
  size: (bytes: number) => string,
): string {
  try {
    switch (subject.kind) {
      case 'run_command':
        return commandSentence(subject, t);
      case 'write_file':
      case 'edit_file':
        return fileSentence(subject, t, size);
      case 'tool':
        return toolSentence(subject, t);
      default:
        return genericSentence(t);
    }
  } catch {
    return genericSentence(t);
  }
}

/** The subject of a workflow's command or file-change request. */
export function computerApprovalSubject(request: ComputerRequest): ApprovalSubject {
  const flag: ApprovalFlag | undefined = request.risky ? 'risky' : undefined;
  if (request.kind === 'run_command') {
    return {
      kind: 'run_command',
      program: request.program,
      args: request.args,
      folder: request.folder,
      path: request.path,
      flag,
    };
  }
  return {
    kind: request.kind,
    path: request.path,
    folder: request.folder,
    content: request.content,
    previous: request.previous,
    flag,
  };
}
