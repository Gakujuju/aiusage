import { describe, it, expect } from 'vitest'
import { classifyQuotaError } from '../src/quota-error.js'

describe('classifyQuotaError', () => {
  it('reports nothing for a successful query', () => {
    expect(classifyQuotaError({ credentialStatus: 'valid', success: true, error: null })).toBe('')
  })

  it('reports auth for an expired credential', () => {
    expect(classifyQuotaError({
      credentialStatus: 'expired',
      success: false,
      error: 'Authentication failed (HTTP 401). Please re-login with Codex CLI.',
    })).toBe('auth')
  })

  it('reports parse for an unreadable credential file', () => {
    expect(classifyQuotaError({
      credentialStatus: 'parse_error',
      success: false,
      error: 'accessToken is empty or missing',
    })).toBe('parse')
  })

  it('reports network for a failed fetch, which the reader still calls valid', () => {
    // The exact shape apiError() produces when fetch throws — credentialStatus
    // stays 'valid', which is why the error text has to be read.
    expect(classifyQuotaError({
      credentialStatus: 'valid',
      success: false,
      error: 'Network error: TypeError: fetch failed',
    })).toBe('network')
  })

  it('reports api for an upstream HTTP failure', () => {
    expect(classifyQuotaError({
      credentialStatus: 'valid',
      success: false,
      error: 'API error (HTTP 503): upstream unavailable',
    })).toBe('api')
  })

  it('reports api for an unparseable upstream response', () => {
    expect(classifyQuotaError({
      credentialStatus: 'valid',
      success: false,
      error: 'Failed to parse API response: SyntaxError',
    })).toBe('api')
  })

  it('reports nothing when the tool is simply not installed', () => {
    // not_found carries no error text — nothing is wrong.
    expect(classifyQuotaError({
      credentialStatus: 'not_found',
      success: false,
      error: null,
    })).toBe('')
  })

  it('prefers the credential status over the error text', () => {
    expect(classifyQuotaError({
      credentialStatus: 'expired',
      success: false,
      error: 'Network error: TypeError: fetch failed',
    })).toBe('auth')
  })

  it('survives null, undefined and empty input', () => {
    expect(classifyQuotaError(null)).toBe('')
    expect(classifyQuotaError(undefined)).toBe('')
    expect(classifyQuotaError({})).toBe('')
  })
})
