import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SERVE_HOST,
  checkHostSafety,
  resolveServeHost,
} from '../../src/commands/serve.js'

describe('resolveServeHost', () => {
  it('defaults to loopback', () => {
    expect(resolveServeHost(undefined, {})).toBe(DEFAULT_SERVE_HOST)
    expect(DEFAULT_SERVE_HOST).toBe('127.0.0.1')
  })

  it('prefers --host over AIUSAGE_HOST over the default', () => {
    expect(resolveServeHost('0.0.0.0', { AIUSAGE_HOST: '192.168.1.5' })).toBe('0.0.0.0')
    expect(resolveServeHost(undefined, { AIUSAGE_HOST: '192.168.1.5' })).toBe('192.168.1.5')
    expect(resolveServeHost('  10.0.0.4  ', {})).toBe('10.0.0.4')
  })

  it('ignores blank values rather than binding to an empty host', () => {
    expect(resolveServeHost('   ', {})).toBe(DEFAULT_SERVE_HOST)
    expect(resolveServeHost(undefined, { AIUSAGE_HOST: '  ' })).toBe(DEFAULT_SERVE_HOST)
  })
})

describe('checkHostSafety', () => {
  it('allows a loopback bind with no password and says nothing', () => {
    const verdict = checkHostSafety('127.0.0.1', {})
    expect(verdict).toEqual({ allowed: true, insecure: false, message: null })
  })

  it('refuses a network bind with no password', () => {
    const verdict = checkHostSafety('0.0.0.0', {})
    expect(verdict.allowed).toBe(false)
    expect(verdict.insecure).toBe(true)
    expect(verdict.message).toContain('0.0.0.0')
    // The message has to name the way out, or the refusal is just a wall.
    expect(verdict.message).toContain('AIUSAGE_DASHBOARD_PASSWORD')
    expect(verdict.message).toContain('AIUSAGE_ALLOW_INSECURE_HOST')
  })

  it('allows a network bind once a password is set', () => {
    const verdict = checkHostSafety('0.0.0.0', { AIUSAGE_DASHBOARD_PASSWORD: 'secret' })
    expect(verdict).toEqual({ allowed: true, insecure: false, message: null })
  })

  it('allows a network bind under the escape hatch, but warns', () => {
    const verdict = checkHostSafety('192.168.1.5', { AIUSAGE_ALLOW_INSECURE_HOST: '1' })
    expect(verdict.allowed).toBe(true)
    expect(verdict.insecure).toBe(true)
    expect(verdict.message).toContain('192.168.1.5')
  })

  it('only accepts the exact escape-hatch value', () => {
    // 'true'/'yes'/'0' are all things someone types by accident. An escape
    // hatch that opens on anything truthy is one that opens unintentionally.
    expect(checkHostSafety('0.0.0.0', { AIUSAGE_ALLOW_INSECURE_HOST: 'true' }).allowed).toBe(false)
    expect(checkHostSafety('0.0.0.0', { AIUSAGE_ALLOW_INSECURE_HOST: '0' }).allowed).toBe(false)
  })

  it('ignores an empty password', () => {
    expect(checkHostSafety('0.0.0.0', { AIUSAGE_DASHBOARD_PASSWORD: '' }).allowed).toBe(false)
  })
})
