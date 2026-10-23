import { defineConfig } from '../../client/node_modules/@playwright/test/index.mjs';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*-ui.spec.mjs',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 12000 },
  reporter: [['list'], ['html', { outputFolder: '../results/client-ui-report', open: 'never' }]],
  outputDir: '../results/client-ui-artifacts',
  use: {
    baseURL: process.env.RIGHTDATA_CLIENT_URL || 'http://127.0.0.1:1420',
    browserName: 'chromium',
    channel: 'msedge',
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
