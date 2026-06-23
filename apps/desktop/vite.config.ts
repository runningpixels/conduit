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
});
