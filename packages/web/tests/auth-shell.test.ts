import { describe, expect, it } from 'vitest'
import { getAuthShellState } from '../src/lib/auth-shell.js'

describe('auth shell state', () => {
  it('uses full shell when password auth is disabled', () => {
    expect(getAuthShellState({ pathname: '/', authEnabled: false, authenticated: false, authLoading: false })).toBe('shell')
    expect(getAuthShellState({ pathname: '/overview', authEnabled: false, authenticated: false, authLoading: false })).toBe('shell')
  })

  it('uses public home shell for unauthenticated home page', () => {
    expect(getAuthShellState({ pathname: '/', authEnabled: true, authenticated: false, authLoading: false })).toBe('public-home')
  })

  it('uses login page for unauthenticated protected routes', () => {
    expect(getAuthShellState({ pathname: '/tokens', authEnabled: true, authenticated: false, authLoading: false })).toBe('login-page')
  })

  it('uses full shell after authentication', () => {
    expect(getAuthShellState({ pathname: '/', authEnabled: true, authenticated: true, authLoading: false })).toBe('shell')
    expect(getAuthShellState({ pathname: '/tokens', authEnabled: true, authenticated: true, authLoading: false })).toBe('shell')
  })

  it('shows loading shell for protected routes while auth status loads', () => {
    expect(getAuthShellState({ pathname: '/tokens', authEnabled: false, authenticated: false, authLoading: true })).toBe('loading')
  })
})

describe('when the home page is not public either', () => {
  /**
   * Binding to anything but loopback protects every /api/ path, home's
   * included. The public home then has nothing to show and — before this —
   * no way to reach the login form, which is how a phone on Tailscale ended
   * up looking at "Authentication required" and a refresh button.
   */
  const locked = { authEnabled: true, authenticated: false, authLoading: false, publicHome: false }

  it('sends the home page to the login form', () => {
    expect(getAuthShellState({ pathname: '/', ...locked })).toBe('login-page')
  })

  it('still opens the full shell once logged in', () => {
    expect(getAuthShellState({ pathname: '/', ...locked, authenticated: true })).toBe('shell')
  })

  it('changes nothing for the other routes', () => {
    expect(getAuthShellState({ pathname: '/tokens', ...locked })).toBe('login-page')
    expect(getAuthShellState({ pathname: '/tokens', ...locked, authenticated: true })).toBe('shell')
  })

  it('keeps the public home when the server says it is public', () => {
    expect(getAuthShellState({ pathname: '/', ...locked, publicHome: true })).toBe('public-home')
  })

  it('treats a missing flag as public, which is what older servers did', () => {
    // An older serve does not send the field at all. Reading undefined as
    // "locked" would put a login page in front of a home page that works.
    expect(getAuthShellState({
      pathname: '/', authEnabled: true, authenticated: false, authLoading: false,
    })).toBe('public-home')
    expect(getAuthShellState({
      pathname: '/', authEnabled: true, authenticated: false, authLoading: false, publicHome: undefined,
    })).toBe('public-home')
  })
})
