import { vi } from 'vitest'
import { setRuntimePriceTable, type PriceEntry } from '@aiusage/core'

const TEST_PRICE_TABLE: Record<string, PriceEntry> = {
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'gpt-4o': { input: 2.5, output: 10 },
  'qoder-auto': { input: 2, output: 2, cacheRead: 2, cacheWrite: 2 },
  'qoder-ultimate': { input: 1.6, output: 1.6, cacheRead: 1.6, cacheWrite: 1.6 },
  'qoder-efficient': { input: 0.6, output: 0.6, cacheRead: 0.6, cacheWrite: 0.6 },
}

setRuntimePriceTable(TEST_PRICE_TABLE)

/**
 * No dashboard password unless a test asks for one.
 *
 * getDashboardPassword falls back to config.credentials, and the CLI tests
 * read the real ~/.aiusage/config.json — so once a password was stored on
 * this machine, every API test that expects an unauthenticated 200 started
 * getting 401. The suite was describing the developer's box rather than the
 * code. Tests that want a password set AIUSAGE_DASHBOARD_PASSWORD, which
 * still wins.
 */
vi.mock('../src/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/auth.js')>()
  return {
    ...actual,
    getDashboardPassword: () => {
      const fromEnv = process.env.AIUSAGE_DASHBOARD_PASSWORD?.trim()
      return fromEnv ? fromEnv : null
    },
  }
})
