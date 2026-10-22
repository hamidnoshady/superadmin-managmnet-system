import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The browser-facing UI talks only to same-origin /api, proxied to the local
// worker. It never calls localhost from a remote browser — the proxy is the
// single hop to the backend.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: process.env.DCC_API_TARGET ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: process.env.DCC_API_TARGET ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
});
