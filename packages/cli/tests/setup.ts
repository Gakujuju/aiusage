import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Every test runs against its own installation directory.
 *
 * **Do not mock homedir() or AIUSAGE_DIR in individual test files.** This
 * is the one place isolation is arranged, and it is arranged for every
 * test at once. Three different mechanisms had grown up before this line
 * existed — a homedir mock here, an AIUSAGE_DIR mock there, and everywhere
 * else nothing at all, reading and writing the real installation.
 *
 * The cost of "nothing at all" is on the record twice. The test suite
 * deleted the watermark and stopped ingestion for 38 minutes, and the note
 * below describes the same thing happening to the dashboard password. Both
 * were closed one symptom at a time; this closes the door they came
 * through.
 *
 * Set before any module reads it: AIUSAGE_DIR is resolved once, when
 * config.ts is first imported, so an override applied later does nothing.
 * setupFiles run before the test file and its imports, which is what makes
 * this work at all.
 *
 * A directory per test file, not per run — mkdtemp gives a fresh one each
 * time this file is evaluated, and vitest evaluates it once per test file.
 * Tests that need a fresh directory per *test* pass one explicitly, the way
 * runParse and cleanAll now accept.
 */
/**
 * The root this test file may treat as a home directory.
 *
 * A test that also needs to fake homedir() — because discovery looks there
 * for a tool's logs — should mock it to this, so the fixture logs and the
 * installation directory end up in the same isolated place instead of
 * disagreeing. dirname(AIUSAGE_HOME) gets you here from anywhere.
 */
const testHomeRoot = mkdtempSync(join(tmpdir(), 'aiusage-test-'))
process.env.AIUSAGE_HOME = join(testHomeRoot, '.aiusage')
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
