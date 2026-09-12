import { defineConfig } from '@playwright/test';

const chromePath = process.env.PP_E2E_CHROME_PATH;
const headless = process.env.PP_E2E_HEADLESS === '1';

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'e2e-artifacts',
  timeout: 30_000,
  expect: { timeout: 12_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [
    ['list'],
    ['json', { outputFile: 'e2e-artifacts/results.json' }],
  ],
  use: {
    baseURL: process.env.PP_E2E_URL ?? 'https://propresenter-remote.alice-data-lab.workers.dev',
    browserName: 'chromium',
    ...(chromePath ? {} : { channel: 'chrome' }),
    launchOptions: {
      ...(chromePath ? { executablePath: chromePath } : {}),
    },
    headless,
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
