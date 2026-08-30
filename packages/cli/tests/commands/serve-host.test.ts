import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SERVE_HOST,
  checkHostSafety,
  resolveServeHost,
  resolveServeHosts,
  runServeCommand,
} from '../../src/commands/serve.js'
import { isLoopbackHost, shouldProtectApiPath } from '../../src/auth.js'

describe('resolveServeHost', () => {
  it('defaults to loopback', () => {
    expect(resolveServeHost(undefined, {})).toBe(DEFAULT_SERVE_HOST)
    expect(DEFAULT_SERVE_HOST).toBe('127.0.0.1')
  })

  it('reports loopback as the primary, whatever else was asked for', () => {
    // The primary is the interface whose port-in-use retry settles the port,
    // and that is always loopback now. The full list is resolveServeHosts.
    expect(resolveServeHost('0.0.0.0', { AIUSAGE_HOST: '192.168.1.5' })).toBe('127.0.0.1')
    expect(resolveServeHost(undefined, {})).toBe('127.0.0.1')
  })

  it('still lets --host win over AIUSAGE_HOST', () => {
    expect(resolveServeHosts('0.0.0.0', { AIUSAGE_HOST: '192.168.1.5' }))
      .toEqual(['127.0.0.1', '0.0.0.0'])
    expect(resolveServeHosts(undefined, { AIUSAGE_HOST: '192.168.1.5' }))
      .toEqual(['127.0.0.1', '192.168.1.5'])
    expect(resolveServeHosts('  10.0.0.4  ', {})).toEqual(['127.0.0.1', '10.0.0.4'])
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

    // The whole list is handed over, not just the primary.
    expect(d.served[0]?.host).toBe('127.0.0.1,0.0.0.0')
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

describe('resolveServeHosts', () => {
  it('defaults to loopback alone', () => {
    expect(resolveServeHosts(undefined, {})).toEqual(['127.0.0.1'])
  })

  it('splits a comma-separated list, ignoring spacing and empties', () => {
    expect(resolveServeHosts('127.0.0.1, 100.82.102.59', {}))
      .toEqual(['127.0.0.1', '100.82.102.59'])
    expect(resolveServeHosts('  100.82.102.59 ,, ,0.0.0.0  ', {}))
      .toEqual(['127.0.0.1', '100.82.102.59', '0.0.0.0'])
  })

  it('always listens on loopback, asked for or not', () => {
    // agent-event posts to 127.0.0.1 and the widget connects to localhost.
    // Binding only the Tailscale address makes both unreachable, and
    // agent-event spools rather than erroring — so the whole hook pipeline
    // would stop with nothing in any log to say why.
    expect(resolveServeHosts('100.82.102.59', {})).toEqual(['127.0.0.1', '100.82.102.59'])
    expect(resolveServeHosts('0.0.0.0', {})).toEqual(['127.0.0.1', '0.0.0.0'])
  })

  it('puts loopback first, so it decides the port', () => {
    expect(resolveServeHosts('100.82.102.59,127.0.0.1', {})[0]).toBe('127.0.0.1')
  })

  it('does not list the same address twice', () => {
    expect(resolveServeHosts('127.0.0.1,127.0.0.1,100.82.102.59', {}))
      .toEqual(['127.0.0.1', '100.82.102.59'])
  })

  it('takes AIUSAGE_HOST when no flag is given, and the flag when both are', () => {
    expect(resolveServeHosts(undefined, { AIUSAGE_HOST: '100.82.102.59' }))
      .toEqual(['127.0.0.1', '100.82.102.59'])
    expect(resolveServeHosts('10.0.0.4', { AIUSAGE_HOST: '100.82.102.59' }))
      .toEqual(['127.0.0.1', '10.0.0.4'])
  })

  it('agrees with resolveServeHost on the primary interface', () => {
    expect(resolveServeHost('100.82.102.59', {})).toBe('127.0.0.1')
  })
})

describe('checkHostSafety over a list', () => {
  it('asks for nothing when every listener is loopback', () => {
    expect(checkHostSafety(['127.0.0.1'], {}))
      .toEqual({ allowed: true, insecure: false, message: null })
    expect(checkHostSafety(['127.0.0.1', 'localhost', '::1'], {}))
      .toEqual({ allowed: true, insecure: false, message: null })
  })

  it('requires a password if even one listener is reachable', () => {
    // The loopback listener beside it does not make the other one private.
    const verdict = checkHostSafety(['127.0.0.1', '100.82.102.59'], {})
    expect(verdict.allowed).toBe(false)
    expect(verdict.message).toContain('100.82.102.59')
    // The refusal names only the exposed one; 127.0.0.1 is not the problem.
    expect(verdict.message).not.toContain('127.0.0.1')
  })

  it('names every exposed listener', () => {
    const verdict = checkHostSafety(['127.0.0.1', '100.82.102.59', '10.0.0.4'], {})
    expect(verdict.message).toContain('100.82.102.59')
    expect(verdict.message).toContain('10.0.0.4')
  })

  it('is satisfied by a password', () => {
    expect(checkHostSafety(['127.0.0.1', '100.82.102.59'], { AIUSAGE_DASHBOARD_PASSWORD: 'secret' }))
      .toEqual({ allowed: true, insecure: false, message: null })
  })

  it('still accepts a single host, as the older callers pass it', () => {
    expect(checkHostSafety('127.0.0.1', {}).allowed).toBe(true)
    expect(checkHostSafety('0.0.0.0', {}).allowed).toBe(false)
  })
})

describe('open endpoints follow the widest listener', () => {
  it('keeps summary and quotas open only when every listener is loopback', () => {
    const allLoopback = ['127.0.0.1', '::1'].every(isLoopbackHost)
    expect(allLoopback).toBe(true)
    expect(shouldProtectApiPath('/api/summary', allLoopback)).toBe(false)

    const mixed = ['127.0.0.1', '100.82.102.59'].every(isLoopbackHost)
    expect(mixed).toBe(false)
    expect(shouldProtectApiPath('/api/summary', mixed)).toBe(true)
    expect(shouldProtectApiPath('/api/quotas', mixed)).toBe(true)
  })
})
