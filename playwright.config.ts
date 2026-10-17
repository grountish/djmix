import { defineConfig } from '@playwright/test';

/**
 * Live tests: the app in a real (headless) Chromium with a running AudioContext, driven through
 * `window.__djmix` (development builds only). They play audio in real time, so they are slow and
 * run on demand: `npm run test:live`.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 8 * 60_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5174',
    browserName: 'chromium',
    headless: true,
    launchOptions: {
      // The AudioContext must run without a click, in real time, with the window unfocused.
      args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
    },
  },
  // Its own Vite server, apart from the one the app is developed on, with HMR off: edits made
  // during a run (which plays minutes of audio) would otherwise reload the page under the test.
  webServer: {
    command: 'npx vite --port 5174 --strictPort',
    url: 'http://localhost:5174',
    reuseExistingServer: false,
    timeout: 60_000,
    env: { DJMIX_LIVE_TEST: '1' },
  },
});
