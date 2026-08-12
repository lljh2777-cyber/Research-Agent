import { defineConfig, devices } from '@playwright/test'
import { fileURLToPath } from 'node:url'

export function quoteShellArgument(value, platform = process.platform) {
  const argument = String(value)

  if (platform === 'win32') {
    if (argument.includes('"')) {
      throw new Error('Windows shell arguments cannot contain double quotes')
    }

    return `"${argument}"`
  }

  return `'${argument.replaceAll("'", "'\\''")}'`
}

const viteCliPath = fileURLToPath(new URL('./node_modules/vite/bin/vite.js', import.meta.url))
const viteCommand = `${quoteShellArgument(process.execPath)} ${quoteShellArgument(viteCliPath)} --host 127.0.0.1 --port 4173 --strictPort`

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: 'local-runtime.manifest.spec.js',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
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
    command: viteCommand,
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
