import { describe, it, expect } from 'vitest'
import { resolveProjectDisplayName } from '../src/project-naming.js'

describe('resolveProjectDisplayName', () => {
  const aliases = { 'shijo-parking-guide': '四条駐車場プロジェクト' }

  it('uses the alias when one is configured', () => {
    expect(resolveProjectDisplayName('shijo-parking-guide', aliases)).toBe('四条駐車場プロジェクト')
  })

  it('falls back to the key, so an unmapped project reads as before', () => {
    expect(resolveProjectDisplayName('aiusage', aliases)).toBe('aiusage')
    expect(resolveProjectDisplayName('aiusage')).toBe('aiusage')
    expect(resolveProjectDisplayName('aiusage', {})).toBe('aiusage')
  })

  it('ignores a blank alias rather than showing an empty label', () => {
    expect(resolveProjectDisplayName('x', { x: '' })).toBe('x')
    expect(resolveProjectDisplayName('x', { x: '   ' })).toBe('x')
  })

  it('handles a missing project name', () => {
    expect(resolveProjectDisplayName('', aliases)).toBe('')
    expect(resolveProjectDisplayName(undefined as unknown as string)).toBe('')
  })
})
