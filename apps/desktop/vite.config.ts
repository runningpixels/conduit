import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(new URL(import.meta.url)));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@conduit/config-schema': path.resolve(rootDir, '../../packages/config-schema/src'),
      '@conduit/ui': path.resolve(rootDir, '../../packages/ui/src'),
    },
  },
  server: {
    port: 5173,
  },
  test: {
    // M6: artifact renderer tests need a DOM. Pure-function tests (escape,
    // buildArtifactCsp, selectRenderer dispatch) also pass under jsdom.
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
