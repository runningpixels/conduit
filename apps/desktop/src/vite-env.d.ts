// Side-effect CSS imports from packages/ui resolve through the vite alias;
// declare the module so tsc -b typechecks clean. (Vite handles these at build.)
declare module '*.css';