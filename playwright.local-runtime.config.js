import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'local-runtime.manifest.spec.js',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5183',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(process.env.CI ? {} : { channel: 'chrome' }),
      },
    },
  ],
  webServer: {
    command: 'npm run dev',
    env: {
      ...process.env,
      BIORESEARCH_VAULT_ROOT: './tests/fixtures/runtime-vault',
      BIORESEARCH_VITE_PORT: '5183',
      BIORESEARCH_KNOWLEDGE_PROVIDER_ID: 'compatible',
      BIORESEARCH_KNOWLEDGE_PROVIDER_ENDPOINT: 'http://127.0.0.1:1234/v1',
      BIORESEARCH_KNOWLEDGE_PROVIDER_MODEL: 'local-e2e-model',
      BIORESEARCH_KNOWLEDGE_PROVIDER_CREDENTIAL: 'not-required',
    },
    url: 'http://localhost:5183',
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
