import { invoke } from '@tauri-apps/api/core';
import type { AppError } from '@conduit/config-schema';
import { EN_MESSAGES, type Translate } from '../i18n';

/**
 * The renderer half of D9: Rust sends a code, this turns it into a sentence.
 *
 * A command's `Err` arrives as `{ code, params, fallback }` once its file has
 * been converted, and as a bare string until then. Both shapes land here and
 * both come out as an `IpcError`, so a call site never has to know which kind
 * of command it just called.
 *
 * **`IpcError` deliberately does not extend `Error`.** Every existing catch
 * site does `String(e)`, and `String(new Error('x'))` is `"Error: x"` — so
 * subclassing would have prefixed a hundred toast messages overnight. With a
 * plain class and a `toString`, `String(e)` still yields exactly the English
 * text it yields today, and the code is there for anyone who wants to
 * translate it. Converting the call sites is then optional rather than
 * urgent, which is the whole point of an incremental migration.
 */
export class IpcError {
  /** A catalog key, or `error.unknown` for anything not yet triaged. */
  readonly code: string;
  readonly params: Record<string, string>;
  /** English, always populated by Rust. */
  readonly fallback: string;

  constructor(code: string, params: Record<string, string>, fallback: string) {
    this.code = code;
    this.params = params;
    this.fallback = fallback;
  }

  /** The English text — what `String(e)` and template interpolation give. */
  toString(): string {
    return this.fallback;
  }

  /** So `e.message` works for code written against `Error`. */
  get message(): string {
    return this.fallback;
  }
}

/** `true` for the `{ code, params, fallback }` shape `AppError` serializes to. */
function isAppError(value: unknown): value is AppError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<AppError>;
  return typeof candidate.code === 'string' && typeof candidate.fallback === 'string';
}

/** Normalise anything a rejected `invoke` can produce into an `IpcError`. */
export function toIpcError(rejection: unknown): IpcError {
  if (rejection instanceof IpcError) return rejection;
  if (isAppError(rejection)) {
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(rejection.params ?? {})) {
      if (typeof value === 'string') params[key] = value;
    }
    return new IpcError(rejection.code, params, rejection.fallback);
  }
  /* A command whose file has not been converted yet still rejects with a plain
   * string. It has no code, and inventing one would be a lie — `error.unknown`
   * is what it is. */
  return new IpcError('error.unknown', {}, String(rejection));
}

/**
 * The sentence to show a user for a failed command.
 *
 * Falls back to the English text whenever the catalog does not know the code,
 * which is the same rule D5 applies to every other message: a user must never
 * read `error.validation.temperatureRange` out of a dialog. That happens for
 * `error.unknown`, for a Rust build newer than the catalog, and for the whole
 * untriaged tail — all of which are honest resting states, not failures.
 */
export function translateError(rejection: unknown, t: Translate): string {
  const error = toIpcError(rejection);
  if (error.code in EN_MESSAGES) return t(error.code, error.params);
  return error.fallback;
}

/**
 * `invoke`, with rejections normalised.
 *
 * Every command in `client.ts` goes through this rather than calling `invoke`
 * directly, so the boundary is one function wide and a call site cannot
 * accidentally receive a raw `AppError` object and stringify it to
 * `[object Object]`.
 */
export async function invokeCommand<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    /* Forwarded with the same arity it arrived with: `invoke(cmd)` and
     * `invoke(cmd, undefined)` are the same to Tauri but not to a spy, and
     * `client.test.ts` asserts on the exact arguments. */
    return args === undefined ? await invoke<T>(command) : await invoke<T>(command, args);
  } catch (rejection) {
    throw toIpcError(rejection);
  }
}
