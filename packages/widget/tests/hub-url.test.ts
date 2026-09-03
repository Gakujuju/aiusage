import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/*
 * Which machine the widget is talking to, and how it decided.
 *
 * Worth a test because the answer is now shown to people. The settings panel
 * puts the resolved address under an empty address box, so a wrong answer
 * here is not an internal detail any more - it is a sentence on screen
 * telling someone their spoke is reading itself.
 *
 * The module reads homedir() at import time, so each case gets a fresh
 * temporary home and a fresh import.
 */
let home: string

async function loadModule() {
  vi.resetModules()
  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os')
    return { ...actual, homedir: () => home }
  })
  return import('../src/hub-url')
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aiusage-huburl-'))
  writeFileSync(join(home, '.aiusage-placeholder'), '')
})

afterEach(() => {
  vi.doUnmock('node:os')
  rmSync(home, { recursive: true, force: true })
})

function writeHome(files: Record<string, string>) {
  const dir = join(home, '.aiusage')
  require('node:fs').mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body)
  }
}

describe('resolveHubUrl', () => {
  it('uses what the user typed, over everything else', async () => {
    writeHome({ 'config.json': JSON.stringify({ hubForward: { url: 'http://hub.example:3847' } }) })
    const { resolveHubUrl } = await loadModule()
    expect(resolveHubUrl('http://typed.example:3847/')).toBe('http://typed.example:3847')
  })

  it('uses the hub this machine forwards to, when nothing was typed', async () => {
    // The spoke case. This is the value the settings panel shows as the
    // placeholder, and showing 127.0.0.1 here instead - which it did - is
    // indistinguishable from a machine that really is reading itself.
    writeHome({ 'config.json': JSON.stringify({ hubForward: { url: 'http://hub.example:3847/' } }) })
    const { resolveHubUrl } = await loadModule()
    expect(resolveHubUrl('')).toBe('http://hub.example:3847')
    expect(resolveHubUrl(null)).toBe('http://hub.example:3847')
  })

  it('falls back to this machine on the port serve wrote', async () => {
    // The hub case, where 127.0.0.1 is the right answer.
    writeHome({ 'config.json': JSON.stringify({ device: 'hub' }), '.serve-port': '3847\n' })
    const { resolveHubUrl } = await loadModule()
    expect(resolveHubUrl('')).toBe('http://127.0.0.1:3847')
  })

  it('falls back to the default port when serve has not written one', async () => {
    writeHome({ 'config.json': JSON.stringify({}) })
    const { resolveHubUrl } = await loadModule()
    expect(resolveHubUrl('')).toBe('http://127.0.0.1:3847')
  })

  it('treats a missing config as a first run, not a fault', async () => {
    const { resolveHubUrl } = await loadModule()
    expect(resolveHubUrl('')).toBe('http://127.0.0.1:3847')
  })

  it('refuses to guess when config.json is there and will not parse', async () => {
    // A BOM, which is what actually happened: PowerShell's Set-Content
    // -Encoding UTF8 writes one, JSON.parse throws, and the old code caught
    // that and quietly answered "this machine".
    writeHome({ 'config.json': '﻿' + JSON.stringify({ hubForward: { url: 'http://hub.example:3847' } }) })
    const { resolveHubUrl, ConfigUnreadableError } = await loadModule()
    expect(() => resolveHubUrl('')).toThrow(ConfigUnreadableError)
    expect(() => resolveHubUrl('')).toThrow(/BOM/)
  })

  it('still answers when the address was typed, even with a broken config', async () => {
    // The way out that does not involve editing the broken file.
    writeHome({ 'config.json': '{ not json' })
    const { resolveHubUrl } = await loadModule()
    expect(resolveHubUrl('http://typed.example:3847')).toBe('http://typed.example:3847')
  })
})
