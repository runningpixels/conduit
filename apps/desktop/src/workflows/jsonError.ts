/// Plain wording for a failed `JSON.parse`, for the editor's JSON view.
///
/// The engine's message ("Expected double-quoted property name in JSON at
/// position 73") names a character offset and uses parser vocabulary. This
/// turns it into "Line 4, column 12: …" plus the usual cause, in the user's
/// language. Messages differ between engines, so anything unrecognised gets a
/// generic hint; with no position at all the caller falls back to the raw text.

import type { Translate } from '../i18n';

/// Line and column (both 1-based) of a character offset in `text`.
export function lineAndColumn(text: string, position: number): { line: number; column: number } {
  const upTo = text.slice(0, Math.max(0, Math.min(position, text.length)));
  const lines = upTo.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/// What went wrong, as a catalog key.
function problemKey(message: string): string {
  if (/end of (json )?(input|data)/i.test(message)) return 'workspace.workflows.edit.jsonError.endEarly';
  if (/double-quoted property name|property name or '\}'/i.test(message)) {
    return 'workspace.workflows.edit.jsonError.quotedName';
  }
  if (/expected ',' or|after (property value|array element)/i.test(message)) {
    return 'workspace.workflows.edit.jsonError.separator';
  }
  if (/expected ':'|after property name/i.test(message)) return 'workspace.workflows.edit.jsonError.colon';
  if (/unexpected token .?[}\]]/i.test(message)) {
    return 'workspace.workflows.edit.jsonError.closer';
  }
  return 'workspace.workflows.edit.jsonError.generic';
}

/// A short, plain description of why `text` isn't JSON, or `null` when the
/// parser gave no position to point at.
export function describeJsonError(text: string, error: unknown, t: Translate): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const explicit = /\(line (\d+) column (\d+)\)/i.exec(message);
  const at = /position (\d+)/i.exec(message);
  let where: { line: number; column: number } | null = null;
  if (explicit) where = { line: Number(explicit[1]), column: Number(explicit[2]) };
  else {
    if (at) where = lineAndColumn(text, Number(at[1]));
    else if (/end of (json )?(input|data)/i.test(message)) where = lineAndColumn(text, text.length);
  }
  if (!where) return null;
  // An error at the very end is a text that stops early, whatever the engine calls it.
  const atEnd = at != null && Number(at[1]) >= text.trimEnd().length;
  return t('workspace.workflows.edit.jsonError.where', {
    line: where.line,
    column: where.column,
    problem: t(atEnd ? 'workspace.workflows.edit.jsonError.endEarly' : problemKey(message)),
  });
}
