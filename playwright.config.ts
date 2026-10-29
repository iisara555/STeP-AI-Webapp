import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: true,
  timeout: 60000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox'],
    },
  },
  webServer: [
    {
      command: 'npm run dev',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
      env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_PUBLISHABLE_KEY: '' },
    },
    {
      command: 'npm run dev -w web -- --port 5174 --strictPort',
      url: 'http://127.0.0.1:5174',
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
      env: {
        VITE_SUPABASE_URL: 'https://auth.example.test',
        VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_test_only',
      },
    },
    // Cloud Workspace mode: the same app against a test Gateway with a scripted runtime (no AI, no Google).
    {
      command: 'npx tsx server/test/support/e2e-gateway.ts',
      url: 'http://127.0.0.1:8799/healthz',
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
    },
    {
      command: 'npm run dev -w web -- --port 5175 --strictPort',
      url: 'http://127.0.0.1:5175',
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
      env: {
        VITE_SUPABASE_URL: '',
        VITE_SUPABASE_PUBLISHABLE_KEY: '',
        VITE_GATEWAY_URL: 'http://127.0.0.1:8799',
        VITE_GOOGLE_CLIENT_ID: 'synthetic-client.apps.googleusercontent.com',
      },
    },
  ],
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 } } },
    {
      name: 'mobile',
      use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
});
