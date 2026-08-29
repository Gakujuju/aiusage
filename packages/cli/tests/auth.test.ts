import { describe, expect, it } from 'vitest'
import {
  AUTH_COOKIE_NAME,
  buildAuthCookie,
  isAuthenticated,
  isLoopbackHost,
  isPublicPath,
  shouldProtectApiPath,
  verifyPassword,
} from '../src/auth.js'

describe('dashboard auth helpers', () => {
  it('does not require auth when dashboard password is unset', () => {
    expect(verifyPassword(undefined, 'anything')).toBe(true)
    expect(verifyPassword('', 'anything')).toBe(true)
  })

  it('verifies submitted password against configured password', () => {
    expect(verifyPassword('secret', 'secret')).toBe(true)
    expect(verifyPassword('secret', 'wrong')).toBe(false)
  })

  it('allows the dashboard home page and auth endpoints without a session', () => {
    expect(isPublicPath('/')).toBe(true)
    expect(isPublicPath('/index.html')).toBe(true)
    expect(isPublicPath('/api/auth/status')).toBe(true)
    expect(isPublicPath('/api/auth/login')).toBe(true)
  })

  it('protects non-home dashboard routes', () => {
    expect(isPublicPath('/overview')).toBe(false)
    expect(isPublicPath('/tokens')).toBe(false)
    expect(isPublicPath('/settings')).toBe(false)
    expect(isPublicPath('/sessions/session-1')).toBe(false)
  })

  it('protects data and mutating API routes while leaving home summary public', () => {
    expect(shouldProtectApiPath('/api/summary')).toBe(false)
    expect(shouldProtectApiPath('/api/tokens')).toBe(true)
    expect(shouldProtectApiPath('/api/config')).toBe(true)
    expect(shouldProtectApiPath('/api/sync')).toBe(true)
  })

  it('treats the loopback spellings as local, and nothing else', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
    expect(isLoopbackHost('  LocalHost ')).toBe(true)

    expect(isLoopbackHost('0.0.0.0')).toBe(false)
    expect(isLoopbackHost('192.168.1.10')).toBe(false)
    // Inside 127/8, but not a spelling we accept. Erring towards "not
    // loopback" is the safe direction: the cost is an unnecessary password.
    expect(isLoopbackHost('127.0.0.2')).toBe(false)
    expect(isLoopbackHost('')).toBe(false)
    expect(isLoopbackHost(null)).toBe(false)
    expect(isLoopbackHost(undefined)).toBe(false)
  })

  it('stops exempting summary and quotas once the bind is not loopback', () => {
    expect(shouldProtectApiPath('/api/summary', false)).toBe(true)
    expect(shouldProtectApiPath('/api/quotas', false)).toBe(true)
    expect(shouldProtectApiPath('/api/tokens', false)).toBe(true)

    // Public paths stay public either way — login has to be reachable or the
    // password could never be entered.
    expect(shouldProtectApiPath('/api/auth/login', false)).toBe(false)
    expect(shouldProtectApiPath('/overview', false)).toBe(false)
  })

  it('keeps the exemptions on a loopback bind', () => {
    expect(shouldProtectApiPath('/api/summary', true)).toBe(false)
    expect(shouldProtectApiPath('/api/quotas', true)).toBe(false)
  })

  it('recognizes the generated auth cookie', () => {
    const cookie = buildAuthCookie('secret')
    const cookieHeader = cookie.split(';')[0]

    expect(cookieHeader.startsWith(`${AUTH_COOKIE_NAME}=`)).toBe(true)
    expect(isAuthenticated('secret', cookieHeader)).toBe(true)
    expect(isAuthenticated('different', cookieHeader)).toBe(false)
  })
})
