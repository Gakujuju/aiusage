import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveAiusageDir, AIUSAGE_HOME_ENV } from '../src/config.js'

describe('resolveAiusageDir', () => {
  it('defaults to ~/.aiusage', () => {
    expect(resolveAiusageDir({})).toBe(join(homedir(), '.aiusage'))
  })

  it('uses an absolute override as given', () => {
    const target = resolve('/tmp/aiusage-test-home')
    expect(resolveAiusageDir({ [AIUSAGE_HOME_ENV]: target })).toBe(target)
  })

  it('resolves a relative override against the working directory', () => {
    expect(resolveAiusageDir({ [AIUSAGE_HOME_ENV]: '.dev-aiusage' }))
      .toBe(resolve('.dev-aiusage'))
  })

  it('treats blank and whitespace-only as unset', () => {
    const fallback = join(homedir(), '.aiusage')
    expect(resolveAiusageDir({ [AIUSAGE_HOME_ENV]: '' })).toBe(fallback)
    expect(resolveAiusageDir({ [AIUSAGE_HOME_ENV]: '   ' })).toBe(fallback)
    expect(resolveAiusageDir({ [AIUSAGE_HOME_ENV]: '\t\n' })).toBe(fallback)
  })

  it('trims a padded override rather than failing on it', () => {
    expect(resolveAiusageDir({ [AIUSAGE_HOME_ENV]: '  .dev-aiusage  ' }))
      .toBe(resolve('.dev-aiusage'))
  })

  it('does not collide with the per-source path variables', () => {
    // discovery.ts builds AIUSAGE_<SOURCE>_PATH; a source called "home" would
    // be AIUSAGE_HOME_PATH, not AIUSAGE_HOME.
    expect(AIUSAGE_HOME_ENV).toBe('AIUSAGE_HOME')
    expect(AIUSAGE_HOME_ENV.endsWith('_PATH')).toBe(false)
  })
})
