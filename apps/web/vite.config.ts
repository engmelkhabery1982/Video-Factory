import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.BUILDTRAKE_API ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5178,
    // Everything the UI needs is same-origin through the dev proxy, so the
    // browser never has to reach another host.
    proxy: Object.fromEntries(
      ['/api', '/media', '/output', '/data'].map((path) => [path, { target: API, changeOrigin: true }]),
    ),
  },
  preview: { host: '0.0.0.0', port: 5178 },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1200 },
});
