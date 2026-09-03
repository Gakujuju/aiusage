import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SIZE_ORDER, SIZE_TIERS, nearestSize, quotaDetailFor, isSizeName } from '../src/size'

describe('size tiers', () => {
  it('names the four sizes largest first, as the user did', () => {
    expect(SIZE_ORDER).toEqual(['normal', 'small', 'tiny', 'micro'])
  })

  it('shrinks monotonically', () => {
    const zooms = SIZE_ORDER.map((n) => SIZE_TIERS[n].zoom)
    for (let i = 1; i < zooms.length; i++) expect(zooms[i]).toBeLessThan(zooms[i - 1])
  })

  it('only the smallest size fixes the detail, and it fixes it to numbers', () => {
    expect(SIZE_TIERS.normal.detail).toBeNull()
    expect(SIZE_TIERS.small.detail).toBeNull()
    expect(SIZE_TIERS.tiny.detail).toBeNull()
    expect(SIZE_TIERS.micro.detail).toBe('number')
  })
})

describe('nearestSize (migration from zoomFactor)', () => {
  it('maps the old range onto the nearest tier', () => {
    expect(nearestSize(1.5)).toBe('normal')
    expect(nearestSize(1.0)).toBe('normal')
    expect(nearestSize(0.9)).toBe('normal')
    expect(nearestSize(0.8)).toBe('small')
    // 0.7 was the old floor: 0.05 from tiny, 0.10 from small.
    expect(nearestSize(0.7)).toBe('tiny')
    expect(nearestSize(0.65)).toBe('tiny')
    expect(nearestSize(0.5)).toBe('micro')
    expect(nearestSize(0.3)).toBe('micro')
  })

  it('lands on normal for garbage', () => {
    expect(nearestSize(NaN)).toBe('normal')
    expect(nearestSize(Infinity)).toBe('normal')
  })

  it('recognises only the four names', () => {
    expect(isSizeName('micro')).toBe(true)
    expect(isSizeName('huge')).toBe(false)
    expect(isSizeName(1)).toBe(false)
  })
})

describe('quotaDetailFor', () => {
  it('lets the size win when it has an opinion', () => {
    expect(quotaDetailFor('micro', true, 'full')).toBe('number')
    expect(quotaDetailFor('micro', false, 'meter')).toBe('number')
  })

  it('otherwise gives the strip a bar and a number', () => {
    expect(quotaDetailFor('normal', true, 'full')).toBe('percent')
    expect(quotaDetailFor('tiny', true, 'meter')).toBe('percent')
  })

  it('otherwise gives the open panel what was chosen', () => {
    expect(quotaDetailFor('normal', false, 'meter')).toBe('meter')
    expect(quotaDetailFor('small', false, 'full')).toBe('full')
  })
})

/*
 * The migration itself, against a settings file from before sizes existed.
 * settings.ts reads homedir() at import time, so it gets a fresh home and a
 * fresh import.
 */
describe('loadSettings migrates zoomFactor to size once', () => {
  let home: string

  async function load() {
    vi.resetModules()
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os')
      return { ...actual, homedir: () => home }
    })
    return import('../src/settings')
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'aiusage-size-'))
    mkdirSync(join(home, '.aiusage'), { recursive: true })
  })
  afterEach(() => {
    vi.doUnmock('node:os')
    rmSync(home, { recursive: true, force: true })
  })

  it('turns an old zoomFactor into the nearest size and drops the old key', async () => {
    writeFileSync(join(home, '.aiusage', 'widget-settings.json'), JSON.stringify({ zoomFactor: 0.7, locale: 'ja' }))
    const { loadSettings, saveSettings } = await load()
    const s = loadSettings()
    expect(s.size).toBe('tiny')
    expect((s as Record<string, unknown>).zoomFactor).toBeUndefined()
    // And once saved, the file no longer carries the old key either.
    saveSettings(s)
    const written = JSON.parse(readFileSync(join(home, '.aiusage', 'widget-settings.json'), 'utf-8'))
    expect(written.size).toBe('tiny')
    expect(written.zoomFactor).toBeUndefined()
  })

  it('keeps a size that is already there, even if a zoomFactor lingers', async () => {
    writeFileSync(join(home, '.aiusage', 'widget-settings.json'), JSON.stringify({ size: 'small', zoomFactor: 0.5 }))
    const { loadSettings } = await load()
    expect(loadSettings().size).toBe('small')
  })

  it('defaults to normal', async () => {
    const { loadSettings } = await load()
    expect(loadSettings().size).toBe('normal')
  })
})
