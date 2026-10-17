import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  worker: {
    format: 'es',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // Agent worktrees live under .claude/; their edits must not reload the app.
    watch: { ignored: ['**/.claude/**'] },
    // The live tests (npm run test:live) start their own server: an edit made while a test
    // plays its minutes of audio must not reload the page under it.
    hmr: process.env.DJMIX_LIVE_TEST ? false : undefined,
  },
});
