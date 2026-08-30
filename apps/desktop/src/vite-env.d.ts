// Side-effect CSS imports from packages/ui resolve through the vite alias;
// declare the module so tsc -b typechecks clean. (Vite handles these at build.)
declare module '*.css';
// Minimal node:fs surface for tests that read repo files (no @types/node
// in the desktop app). Kept to exactly what tests use.
declare module 'node:fs' {
  export function readFileSync(
    path: string | URL,
    encoding?: string | null,
  ): string;
  export interface Dirent {
    name: string;
    isDirectory(): boolean;
  }
  export function readdirSync(
    path: string,
    options: { withFileTypes: true },
  ): Dirent[];
  export function existsSync(path: string): boolean;
  export function mkdtempSync(prefix: string): string;
  export function mkdirSync(
    path: string,
    options?: { recursive?: boolean },
  ): string | undefined;
  export function writeFileSync(path: string, data: string): void;
  export function rmSync(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): void;
}
// Minimal node:path / node:url surface, same rationale as node:fs above.
declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
  export function relative(from: string, to: string): string;
  export const sep: string;
}
declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}
// Minimal node:os surface -- just enough for tests that stage a scratch
// output directory under the OS temp dir (see brandEquivalence.test.ts).
declare module 'node:os' {
  export function tmpdir(): string;
}
// Minimal node:child_process surface -- just enough to run a `cargo`
// subprocess synchronously and let a non-zero exit throw (the return value
// is intentionally untyped/unused by every current caller).
declare module 'node:child_process' {
  export function execFileSync(
    file: string,
    args?: string[],
    options?: { cwd?: string; stdio?: string },
  ): unknown;
}
// Minimal process surface for tests that resolve repo paths from the cwd.
declare const process: { cwd(): string };