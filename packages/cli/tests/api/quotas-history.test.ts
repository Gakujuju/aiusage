import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'node:http'
import Database from 'better-sqlite3'
import { createApiServer } from '../../src/api/server.js'
import { initializeDatabase } from '../../src/db/index.js'

// The quota routes must never reach the real usage APIs from a test run.
vi.mock('../../src/quota.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/quota.js')>('../../src/quota.js')
  return { ...actual, queryAllQuotas: vi.fn(async () => mockQuotaResults) }
})

import { queryAllQuotas, type QuotaResult } from '../../src/quota.js'

const DEVICE_ID = 'device-uuid-a'
const OTHER_DEVICE_ID = 'device-uuid-b'

let mockQuotaResults: QuotaResult[] = []

function liveSuccess(tool: string, tiers: Array<{ name: string; utilization: number; resetsAt: string | null }>): QuotaResult {
  return {
    tool,
    credentialStatus: 'valid',
    credentialMessage: null,
    success: true,
    tiers,
    error: null,
    queriedAt: 1_700_000_500_000,
  }
}

function liveFailure(tool: string, status: QuotaResult['credentialStatus'], error: string | null): QuotaResult {
  return {
    tool,
    credentialStatus: status,
    credentialMessage: error,
    success: false,
    tiers: [],
    error,
    queriedAt: 1_700_000_500_000,
  }
}

function insertSnapshot(db: Database.Database, row: {
  id: string
  ts: number
  tool: string
  tier: string
  utilization: number
  resetsAt?: number | null
  windowId?: string
  deviceInstanceId?: string
}) {
  db.prepare(`
    INSERT INTO quota_snapshots (id, ts, tool, tier, utilization, resets_at, window_id, device, device_instance_id, created_at)
    VALUES (@id, @ts, @tool, @tier, @utilization, @resetsAt, @windowId, 'host', @deviceInstanceId, @ts)
  `).run({
    resetsAt: null,
    windowId: 'w1',
    deviceInstanceId: DEVICE_ID,
    ...row,
  })
}

function insertCurrent(db: Database.Database, row: {
  tool: string
  tier: string
  utilization: number
  resetsAt?: number | null
  windowId?: string
  ts?: number
  deviceInstanceId?: string
  credStatus?: string
  lastSuccessAt?: number | null
  lastError?: string | null
  lastErrorKind?: string
  consecutiveErrors?: number
}) {
  db.prepare(`
    INSERT INTO quota_current (
      tool, tier, device_instance_id, utilization, resets_at, window_id, ts,
      cred_status, last_success_at, last_error, last_error_kind, consecutive_errors, updated_at
    ) VALUES (
      @tool, @tier, @deviceInstanceId, @utilization, @resetsAt, @windowId, @ts,
      @credStatus, @lastSuccessAt, @lastError, @lastErrorKind, @consecutiveErrors, @ts
    )
  `).run({
    resetsAt: null,
    windowId: 'w1',
    ts: 1_700_000_000_000,
    deviceInstanceId: DEVICE_ID,
    credStatus: 'valid',
    lastSuccessAt: 1_700_000_000_000,
    lastError: null,
    lastErrorKind: '',
    consecutiveErrors: 0,
    ...row,
  })
}

describe('quota history API', () => {
  let db: Database.Database
  let server: http.Server
  let baseUrl: string

  beforeEach(async () => {
    mockQuotaResults = []
    vi.mocked(queryAllQuotas).mockImplementation(async () => mockQuotaResults)
    db = new Database(':memory:')
    initializeDatabase(db)
    server = createApiServer(db, { currentDeviceInstanceId: DEVICE_ID })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as any
        baseUrl = `http://127.0.0.1:${address.port}`
        resolve()
      })
    })
  })

  afterEach(async () => {
    if (server?.listening) {
      server.closeIdleConnections?.()
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    db.close()
  })

  // ── /api/quotas ────────────────────────────────────────────────────────

  /*
   * These describe a promise, not just a behaviour: GET /api/quotas answers
   * from quota_current and never calls upstream. It used to run a full round
   * of live queries per request, which was fine while a person looking at a
   * dashboard was the only caller and became a rate limit the moment two
   * widgets started polling it. See quotasFromStore.
   */
  it('answers from storage without calling upstream', async () => {
    insertCurrent(db, {
      tool: 'codex',
      tier: 'five_hour',
      utilization: 66,
      resetsAt: Date.parse('2026-08-29T12:00:00.000Z'),
      lastSuccessAt: 1_700_000_500_000,
    })
    // Would answer with something else entirely if it were consulted.
    mockQuotaResults = [liveSuccess('codex', [{ name: 'five_hour', utilization: 1, resetsAt: null }])]

    const data = await (await fetch(`${baseUrl}/api/quotas`)).json()
    expect(vi.mocked(queryAllQuotas)).not.toHaveBeenCalled()

    const codex = data.quotas.find((q: any) => q.tool === 'codex')
    expect(codex.tiers).toEqual([
      { name: 'five_hour', utilization: 66, resetsAt: '2026-08-29T12:00:00.000Z' },
    ])
    expect(codex.stale).toBe(false)
    expect(codex.lastSuccessAt).toBe(1_700_000_500_000)
    expect(codex.consecutiveErrors).toBe(0)
  })

  it('names every known tool, so a missing one is not just absent', async () => {
    const data = await (await fetch(`${baseUrl}/api/quotas`)).json()
    expect(data.quotas.map((q: any) => q.tool)).toEqual(['claude-code', 'codex', 'copilot'])
    // The dashboard tells "not signed in" from "signed in and quiet" by this.
    expect(data.quotas.every((q: any) => q.credentialStatus === 'not_found')).toBe(true)
  })

  it('marks a tool stale when its last collection failed', async () => {
    insertCurrent(db, {
      tool: 'codex',
      tier: 'five_hour',
      utilization: 42,
      resetsAt: Date.parse('2026-08-29T12:00:00.000Z'),
      lastSuccessAt: 1_700_000_000_000,
      consecutiveErrors: 3,
      lastErrorKind: 'auth',
    })

    const data = await (await fetch(`${baseUrl}/api/quotas`)).json()
    const codex = data.quotas.find((q: any) => q.tool === 'codex')
    expect(codex.stale).toBe(true)
    expect(codex.tiers).toEqual([
      { name: 'five_hour', utilization: 42, resetsAt: '2026-08-29T12:00:00.000Z' },
    ])
    expect(codex.lastSuccessAt).toBe(1_700_000_000_000)
    expect(codex.consecutiveErrors).toBe(3)
    expect(codex.lastErrorKind).toBe('auth')
  })

  it('carries the stored credential status and error kind', async () => {
    insertCurrent(db, {
      tool: 'codex',
      tier: 'five_hour',
      utilization: 10,
      credStatus: 'valid',
      consecutiveErrors: 2,
      lastErrorKind: 'network',
    })

    const data = await (await fetch(`${baseUrl}/api/quotas`)).json()
    const codex = data.quotas.find((q: any) => q.tool === 'codex')
    // 'valid' plus a network error kind is what "offline" looks like here;
    // 'expired' is what "re-login" looks like. Both come from the row.
    expect(codex.credentialStatus).toBe('valid')
    expect(codex.lastErrorKind).toBe('network')
  })

  it('reports an empty lastErrorKind when the last collection worked', async () => {
    insertCurrent(db, { tool: 'codex', tier: 'five_hour', utilization: 10 })
    const data = await (await fetch(`${baseUrl}/api/quotas`)).json()
    expect(data.quotas.find((q: any) => q.tool === 'codex').lastErrorKind).toBe('')
  })

  it('reports stale=false for a tool with nothing stored', async () => {
    const data = await (await fetch(`${baseUrl}/api/quotas`)).json()
    const claude = data.quotas.find((q: any) => q.tool === 'claude-code')
    expect(claude.stale).toBe(false)
    expect(claude.tiers).toEqual([])
    expect(claude.lastSuccessAt).toBeNull()
  })

  it('stays public and carries no credential material', async () => {
    insertCurrent(db, { tool: 'codex', tier: 'five_hour', utilization: 42, credStatus: 'expired' })

    const response = await fetch(`${baseUrl}/api/quotas`)
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).not.toMatch(/accessToken|access_token|Bearer|oauth_token/i)
  })

  // ── /api/quotas/history ────────────────────────────────────────────────

  it('returns an empty series with no data', async () => {
    const data = await (await fetch(`${baseUrl}/api/quotas/history`)).json()
    expect(data).toEqual({ series: [], truncated: false })
  })

  it('groups points into one series per tool/tier/window', async () => {
    const t0 = Date.now() - 3600_000
    insertSnapshot(db, { id: 's1', ts: t0, tool: 'codex', tier: 'five_hour', utilization: 10, windowId: 'w1' })
    insertSnapshot(db, { id: 's2', ts: t0 + 60_000, tool: 'codex', tier: 'five_hour', utilization: 20, windowId: 'w1' })
    insertSnapshot(db, { id: 's3', ts: t0 + 120_000, tool: 'codex', tier: 'five_hour', utilization: 5, windowId: 'w2' })
    insertSnapshot(db, { id: 's4', ts: t0, tool: 'codex', tier: 'weekly_limit', utilization: 50, windowId: 'w3' })

    const data = await (await fetch(`${baseUrl}/api/quotas/history`)).json()
    expect(data.series).toHaveLength(3)
    const fiveHourW1 = data.series.find((s: any) => s.tier === 'five_hour' && s.windowId === 'w1')
    expect(fiveHourW1.points).toEqual([
      { ts: t0, utilization: 10 },
      { ts: t0 + 60_000, utilization: 20 },
    ])
    expect(data.truncated).toBe(false)
  })

  it('filters by tool, tier and device', async () => {
    const t0 = Date.now() - 3600_000
    insertSnapshot(db, { id: 's1', ts: t0, tool: 'codex', tier: 'five_hour', utilization: 10 })
    insertSnapshot(db, { id: 's2', ts: t0, tool: 'codex', tier: 'weekly_limit', utilization: 20, windowId: 'w2' })
    insertSnapshot(db, { id: 's3', ts: t0, tool: 'claude-code', tier: 'five_hour', utilization: 30, windowId: 'w3' })
    insertSnapshot(db, { id: 's4', ts: t0, tool: 'codex', tier: 'five_hour', utilization: 40, windowId: 'w4', deviceInstanceId: OTHER_DEVICE_ID })

    const byTool = await (await fetch(`${baseUrl}/api/quotas/history?tool=codex`)).json()
    expect(byTool.series.map((s: any) => s.tier).sort()).toEqual(['five_hour', 'five_hour', 'weekly_limit'])

    const byTier = await (await fetch(`${baseUrl}/api/quotas/history?tool=codex&tier=five_hour`)).json()
    expect(byTier.series).toHaveLength(2)

    const byDevice = await (await fetch(`${baseUrl}/api/quotas/history?tool=codex&tier=five_hour&device=${DEVICE_ID}`)).json()
    expect(byDevice.series).toHaveLength(1)
    expect(byDevice.series[0].points[0].utilization).toBe(10)
  })

  it('honours the range window', async () => {
    const now = Date.now()
    insertSnapshot(db, { id: 'old', ts: now - 10 * 86400000, tool: 'codex', tier: 'five_hour', utilization: 10 })
    insertSnapshot(db, { id: 'new', ts: now - 60_000, tool: 'codex', tier: 'five_hour', utilization: 20 })

    const week = await (await fetch(`${baseUrl}/api/quotas/history?range=week`)).json()
    expect(week.series[0].points).toHaveLength(1)

    const all = await (await fetch(`${baseUrl}/api/quotas/history?range=all`)).json()
    expect(all.series[0].points).toHaveLength(2)

    const day = await (await fetch(`${baseUrl}/api/quotas/history?range=day`)).json()
    expect(day.series[0].points).toHaveLength(1)
  })

  it('accepts from/to as ISO strings and as milliseconds', async () => {
    const base = Date.parse('2026-06-01T00:00:00.000Z')
    insertSnapshot(db, { id: 'a', ts: base, tool: 'codex', tier: 'five_hour', utilization: 10 })
    insertSnapshot(db, { id: 'b', ts: base + 86400000, tool: 'codex', tier: 'five_hour', utilization: 20 })
    insertSnapshot(db, { id: 'c', ts: base + 5 * 86400000, tool: 'codex', tier: 'five_hour', utilization: 30 })

    const iso = await (await fetch(
      `${baseUrl}/api/quotas/history?from=2026-06-01T00:00:00.000Z&to=2026-06-02T12:00:00.000Z`
    )).json()
    expect(iso.series[0].points.map((p: any) => p.utilization)).toEqual([10, 20])

    const ms = await (await fetch(`${baseUrl}/api/quotas/history?from=${base}&to=${base + 86400000}`)).json()
    expect(ms.series[0].points.map((p: any) => p.utilization)).toEqual([10, 20])
  })

  it('rejects an invalid range with INVALID_PARAM', async () => {
    const response = await fetch(`${baseUrl}/api/quotas/history?range=fortnight`)
    expect(response.status).toBe(400)
    const data = await response.json()
    expect(data.error.code).toBe('INVALID_PARAM')
  })

  it('rejects an unparseable from with INVALID_PARAM', async () => {
    const response = await fetch(`${baseUrl}/api/quotas/history?from=yesterday`)
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('INVALID_PARAM')
  })

  it('downsamples a series past 2000 points and flags truncated', async () => {
    const t0 = Date.now() - 2500 * 1000
    const insert = db.prepare(`
      INSERT INTO quota_snapshots (id, ts, tool, tier, utilization, resets_at, window_id, device, device_instance_id, created_at)
      VALUES (?, ?, 'codex', 'five_hour', ?, NULL, 'w1', 'host', ?, ?)
    `)
    db.transaction(() => {
      for (let i = 0; i < 2500; i++) {
        insert.run(`p${i}`, t0 + i * 1000, i / 100, DEVICE_ID, t0)
      }
    })()

    const data = await (await fetch(`${baseUrl}/api/quotas/history?range=all`)).json()
    expect(data.truncated).toBe(true)
    expect(data.series[0].points).toHaveLength(2000)
    // Endpoints are preserved so the chart's extremes stay honest.
    expect(data.series[0].points[0].ts).toBe(t0)
    expect(data.series[0].points[1999].ts).toBe(t0 + 2499 * 1000)
  })

  // ── /api/quotas/forecast ───────────────────────────────────────────────

  it('returns 200 with an empty list when there is no data', async () => {
    const response = await fetch(`${baseUrl}/api/quotas/forecast`)
    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.forecasts).toEqual([])
    expect(typeof data.generatedAt).toBe('number')
  })

  it('forecasts the current window from its snapshots', async () => {
    const now = Date.now()
    const windowStart = now - 2 * 3600_000
    const resetsAt = now + 2 * 3600_000
    for (let i = 0; i < 5; i++) {
      insertSnapshot(db, {
        id: `s${i}`,
        ts: windowStart + i * 30 * 60_000,
        tool: 'codex',
        tier: 'five_hour',
        utilization: 40 + i * 10,
        resetsAt,
      })
    }
    insertCurrent(db, { tool: 'codex', tier: 'five_hour', utilization: 80, resetsAt, ts: now })

    const data = await (await fetch(`${baseUrl}/api/quotas/forecast`)).json()
    expect(data.forecasts).toHaveLength(1)
    const f = data.forecasts[0]
    expect(f.tool).toBe('codex')
    expect(f.tier).toBe('five_hour')
    expect(f.current).toBe(80)
    // The window is derived from the reset, not from when we started looking:
    // a five_hour window resetting in 2h began 3h ago, so we are 60 % through.
    expect(f.windowStartInferred).toBe(true)
    expect(f.elapsedRatio).toBeCloseTo(0.6, 2)
    expect(f.paceRatio).toBeCloseTo(0.8 / 0.6, 2)
    expect(f.burnRatePerHour).toBeCloseTo(20, 1)
    // 80 % with 20 %/h left to burn exhausts in an hour; the window resets in two.
    expect(f.exhaustBeforeReset).toBe(true)
    expect(f.risk).toBe('warn')
    expect(f.confidence).toBe('medium')
    expect(f.p90FinalUtilization).toBeNull()
    expect(f.stale).toBe(false)
  })

  it('reports low confidence while samples are still scarce', async () => {
    const now = Date.now()
    insertSnapshot(db, { id: 's1', ts: now - 60_000, tool: 'codex', tier: 'five_hour', utilization: 10 })
    insertCurrent(db, { tool: 'codex', tier: 'five_hour', utilization: 10, ts: now })

    const data = await (await fetch(`${baseUrl}/api/quotas/forecast`)).json()
    expect(data.forecasts[0].confidence).toBe('low')
    expect(data.forecasts[0].risk).toBe('ok')
  })

  it('reports p90 once four windows have closed', async () => {
    const now = Date.now()
    insertCurrent(db, { tool: 'codex', tier: 'five_hour', utilization: 10, ts: now })
    const insert = db.prepare(`
      INSERT INTO quota_windows (window_id, tool, tier, device_instance_id, started_at, resets_at, closed_at, peak_utilization, final_utilization, sample_count)
      VALUES (?, 'codex', 'five_hour', ?, ?, NULL, ?, ?, ?, 3)
    `)
    const finals = [70, 80, 90, 95]
    finals.forEach((final, i) => {
      insert.run(`old${i}`, DEVICE_ID, now - (i + 1) * 86400000, now - (i + 1) * 86400000 + 3600_000, final, final)
    })

    const data = await (await fetch(`${baseUrl}/api/quotas/forecast`)).json()
    expect(data.forecasts[0].p90FinalUtilization).toBeCloseTo(93.5, 6)
  })

  it('reports no pace for a weekly window observed for the first time', async () => {
    // The live shape from 2026-08-29: Codex reports the reset a full week out
    // while nothing is consumed, which used to yield paceRatio 41760.
    const now = Date.now()
    const resetsAt = now + 7 * 86400000
    insertSnapshot(db, { id: 's1', ts: now - 6000, tool: 'codex', tier: 'weekly_limit', utilization: 54, resetsAt })
    insertSnapshot(db, { id: 's2', ts: now, tool: 'codex', tier: 'weekly_limit', utilization: 54, resetsAt })
    insertCurrent(db, { tool: 'codex', tier: 'weekly_limit', utilization: 54, resetsAt, ts: now })

    const data = await (await fetch(`${baseUrl}/api/quotas/forecast`)).json()
    expect(data.forecasts[0].paceRatio).toBeNull()
    expect(data.forecasts[0].risk).toBe('ok')
  })

  it('excludes gapped windows from the p90', async () => {
    const now = Date.now()
    insertCurrent(db, { tool: 'codex', tier: 'five_hour', utilization: 10, ts: now })
    const insert = db.prepare(`
      INSERT INTO quota_windows (window_id, tool, tier, device_instance_id, started_at, resets_at, closed_at, peak_utilization, final_utilization, sample_count, gap_detected)
      VALUES (?, 'codex', 'five_hour', ?, ?, NULL, ?, ?, ?, 3, ?)
    `)
    const finals = [70, 80, 90, 95]
    finals.forEach((final, i) => {
      insert.run(`old${i}`, DEVICE_ID, now - (i + 1) * 86400000, now - (i + 1) * 86400000 + 3600_000, final, final, 0)
    })
    // A gapped window's final value is the last one seen, not the real end.
    insert.run('gapped', DEVICE_ID, now - 10 * 86400000, now - 10 * 86400000 + 3600_000, 5, 5, 1)

    const data = await (await fetch(`${baseUrl}/api/quotas/forecast`)).json()
    // Unchanged by the 5 % outlier: still the p90 of [70, 80, 90, 95].
    expect(data.forecasts[0].p90FinalUtilization).toBeCloseTo(93.5, 6)
  })

  it('returns null p90 when gapped windows leave fewer than four usable ones', async () => {
    const now = Date.now()
    insertCurrent(db, { tool: 'codex', tier: 'five_hour', utilization: 10, ts: now })
    const insert = db.prepare(`
      INSERT INTO quota_windows (window_id, tool, tier, device_instance_id, started_at, resets_at, closed_at, peak_utilization, final_utilization, sample_count, gap_detected)
      VALUES (?, 'codex', 'five_hour', ?, ?, NULL, ?, ?, ?, 3, ?)
    `)
    ;[70, 80, 90].forEach((final, i) => {
      insert.run(`ok${i}`, DEVICE_ID, now - (i + 1) * 86400000, now - (i + 1) * 86400000 + 3600_000, final, final, 0)
    })
    insert.run('gapped', DEVICE_ID, now - 10 * 86400000, now - 10 * 86400000 + 3600_000, 95, 95, 1)

    const data = await (await fetch(`${baseUrl}/api/quotas/forecast`)).json()
    expect(data.forecasts[0].p90FinalUtilization).toBeNull()
  })

  it('marks a forecast stale when the last polls failed', async () => {
    insertCurrent(db, { tool: 'codex', tier: 'five_hour', utilization: 42, consecutiveErrors: 2 })

    const data = await (await fetch(`${baseUrl}/api/quotas/forecast`)).json()
    expect(data.forecasts[0].stale).toBe(true)
  })

  it('filters forecasts by device', async () => {
    insertCurrent(db, { tool: 'codex', tier: 'five_hour', utilization: 10 })
    insertCurrent(db, { tool: 'codex', tier: 'five_hour', utilization: 20, deviceInstanceId: OTHER_DEVICE_ID })

    const all = await (await fetch(`${baseUrl}/api/quotas/forecast`)).json()
    expect(all.forecasts).toHaveLength(2)

    const mine = await (await fetch(`${baseUrl}/api/quotas/forecast?device=${DEVICE_ID}`)).json()
    expect(mine.forecasts).toHaveLength(1)
    expect(mine.forecasts[0].current).toBe(10)
  })

  // ── /api/quotas/refresh ────────────────────────────────────────────────

  it('polls and persists on refresh', async () => {
    mockQuotaResults = [liveSuccess('codex', [{ name: 'five_hour', utilization: 66, resetsAt: '2026-08-29T12:00:00.000Z' }])]

    const response = await fetch(`${baseUrl}/api/quotas/refresh`, { method: 'POST' })
    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.summary.inserted).toBe(1)
    expect(data.quotas[0].stale).toBe(false)

    const stored = db.prepare('SELECT tool, tier, utilization FROM quota_snapshots').get()
    expect(stored).toEqual({ tool: 'codex', tier: 'five_hour', utilization: 66 })
  })

  it('rejects a concurrent refresh with 409 BUSY', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.mocked(queryAllQuotas).mockImplementation(async () => {
      await gate
      return [liveSuccess('codex', [{ name: 'five_hour', utilization: 1, resetsAt: null }])]
    })

    const first = fetch(`${baseUrl}/api/quotas/refresh`, { method: 'POST' })
    // Let the first request reach the in-flight guard before racing it.
    await new Promise((resolve) => setTimeout(resolve, 30))
    const second = await fetch(`${baseUrl}/api/quotas/refresh`, { method: 'POST' })

    expect(second.status).toBe(409)
    expect((await second.json()).error.code).toBe('BUSY')

    release()
    expect((await first).status).toBe(200)
  })

  it('clears the in-flight guard so a later refresh still works', async () => {
    mockQuotaResults = [liveSuccess('codex', [{ name: 'five_hour', utilization: 5, resetsAt: null }])]
    expect((await fetch(`${baseUrl}/api/quotas/refresh`, { method: 'POST' })).status).toBe(200)
    expect((await fetch(`${baseUrl}/api/quotas/refresh`, { method: 'POST' })).status).toBe(200)
  })
})
