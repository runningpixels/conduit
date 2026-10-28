import { toIpcError } from '../../ipc/errors';

/** The code a skill import or save rejects with when the name is taken. */
export const SKILL_EXISTS_CODE = 'error.skills.exists';

/** The taken skill name when `error` is a name conflict, else `null`. The
 *  caller then asks "Replace it?" and retries with `replace: true`. */
export function skillExistsName(error: unknown): string | null {
  const e = toIpcError(error);
  return e.code === SKILL_EXISTS_CODE ? (e.params.name ?? '') : null;
}
