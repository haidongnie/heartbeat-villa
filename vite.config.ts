import { defineConfig } from 'vite';

// GitHub Pages serves the site from /<repo>/; override with BASE=/ for other hosts.
export default defineConfig({
  base: process.env.BASE ?? '/heartbeat-villa/',
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 3000,
  },
  server: { host: true },
});
