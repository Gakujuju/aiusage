import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SERVE_HOST,
  checkHostSafety,
  resolveServeHost,
  runServeCommand,
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

describe('runServeCommand', () => {
  const fakeDb = {} as never

  function deps(env: NodeJS.ProcessEnv) {
    const created: string[] = []
    const served: Array<{ port: number; host?: string }> = []
    const errors: string[] = []
    const exits: number[] = []
    return {
      created,
      served,
      errors,
      exits,
      value: {
        dbPath: '/tmp/does-not-exist/cache.db',
        createDatabase: (path: string) => {
          created.push(path)
          return fakeDb
        },
        serve: (options: { port: number; host?: string }) => {
          served.push(options)
        },
        env,
        onError: (message: string) => {
          errors.push(message)
        },
        onExit: (code: number) => {
          exits.push(code)
        },
      },
    }
  }

  it('refuses without opening the database', () => {
    // createDatabase runs the migrations. A refused start that has already
    // migrated the production database is the failure this ordering exists to
    // prevent, so the assertion is about the call count, not the message.
    const d = deps({})
    runServeCommand({ port: 3847, host: '0.0.0.0' }, d.value)

    expect(d.created).toEqual([])
    expect(d.served).toEqual([])
    expect(d.exits).toEqual([1])
    expect(d.errors[0]).toContain('refusing to listen on 0.0.0.0')
  })

  it('opens the database and serves when the host is allowed', () => {
    const d = deps({})
    runServeCommand({ port: 3847 }, d.value)

    expect(d.created).toEqual(['/tmp/does-not-exist/cache.db'])
    expect(d.served).toEqual([{ port: 3847, host: '127.0.0.1', db: fakeDb }])
    expect(d.exits).toEqual([])
    expect(d.errors).toEqual([])
  })

  it('passes the resolved host down rather than the raw option', () => {
    const d = deps({ AIUSAGE_HOST: '0.0.0.0', AIUSAGE_DASHBOARD_PASSWORD: 'secret' })
    runServeCommand({ port: 3847 }, d.value)

    expect(d.served[0]?.host).toBe('0.0.0.0')
  })

  it('still opens the database under the escape hatch', () => {
    const d = deps({ AIUSAGE_ALLOW_INSECURE_HOST: '1' })
    runServeCommand({ port: 3847, host: '0.0.0.0' }, d.value)

    expect(d.created).toHaveLength(1)
    // The warning belongs to serve(), which is what actually binds. Printing
    // it here too would double it up.
    expect(d.errors).toEqual([])
  })
})
