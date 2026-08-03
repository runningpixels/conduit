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
}
// Minimal process surface for tests that resolve repo paths from the cwd.
declare const process: { cwd(): string };