import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  RuntimeSettingsController,
  DEFAULT_PARSE_INTERVAL_MS,
  DEFAULT_QUOTA_SNAPSHOT_INTERVAL_MS,
  QUOTA_SNAPSHOT_RETRY_DELAY_MS,
} from '../../src/runtime/settings-controller.js'

describe('RuntimeSettingsController', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('starts scheduling when refreshInterval is positive', async () => {
    const loadConfig = vi.fn(() => ({ refreshInterval: 25 }))
    const runParse = vi.fn(async () => {})
    const runCleanup = vi.fn(() => {})
    const controller = new RuntimeSettingsController({ db: {} as any, loadConfig, runParse, runCleanup })

    controller.start()
    await vi.advanceTimersByTimeAsync(25)

    expect(runParse).toHaveBeenCalledTimes(1)
    expect(runCleanup).not.toHaveBeenCalled()
  })

  // Named for zero alone now: blank no longer means the same thing, and the
  // case below covers it.
  it('does not schedule when refreshInterval is zero', async () => {
    const loadConfig = vi.fn(() => ({ refreshInterval: 0 }))
    const runParse = vi.fn(async () => {})
    const runCleanup = vi.fn(() => {})
    const controller = new RuntimeSettingsController({ db: {} as any, loadConfig, runParse, runCleanup })

    controller.start()
    await vi.advanceTimersByTimeAsync(100)

    expect(runParse).not.toHaveBeenCalled()
  })

  it('rebuilds scheduling on reload', async () => {
    let refreshInterval = 25
    const loadConfig = vi.fn(() => ({ refreshInterval }))
    const runParse = vi.fn(async () => {})
    const runCleanup = vi.fn(() => {})
    const controller = new RuntimeSettingsController({ db: {} as any, loadConfig, runParse, runCleanup })

    controller.start()
    await vi.advanceTimersByTimeAsync(25)
    expect(runParse).toHaveBeenCalledTimes(1)

    refreshInterval = 60
    controller.reload()
    await vi.advanceTimersByTimeAsync(59)
    expect(runParse).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(runParse).toHaveBeenCalledTimes(2)
  })

  it('skips overlapping parse runs', async () => {
    let release!: () => void
    const loadConfig = vi.fn(() => ({ refreshInterval: 25 }))
    const runParse = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const runCleanup = vi.fn(() => {})
    const controller = new RuntimeSettingsController({ db: {} as any, loadConfig, runParse, runCleanup })

    controller.start()
    await vi.advanceTimersByTimeAsync(25)
    expect(runParse).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(100)
    expect(runParse).toHaveBeenCalledTimes(1)

    release()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(25)
    expect(runParse).toHaveBeenCalledTimes(2)
  })

  it('starts cleanup scheduling when retentionDays is positive', async () => {
    const loadConfig = vi.fn(() => ({ retentionDays: 7 }))
    const runParse = vi.fn(async () => {})
    const runCleanup = vi.fn(() => {})
    const controller = new RuntimeSettingsController({ db: {} as any, loadConfig, runParse, runCleanup, cleanupIntervalMs: 50 })

    controller.start()
    await vi.advanceTimersByTimeAsync(50)

    expect(runCleanup).toHaveBeenCalledWith({}, 7)
  })

  it('disables cleanup when retentionDays becomes blank or zero', async () => {
    let retentionDays = 7
    const loadConfig = vi.fn(() => ({ retentionDays }))
    const runParse = vi.fn(async () => {})
    const runCleanup = vi.fn(() => {})
    const controller = new RuntimeSettingsController({ db: {} as any, loadConfig, runParse, runCleanup, cleanupIntervalMs: 50 })

    controller.start()
    await vi.advanceTimersByTimeAsync(50)
    expect(runCleanup).toHaveBeenCalledTimes(1)

    retentionDays = 0
    controller.reload()
    await vi.advanceTimersByTimeAsync(200)
    expect(runCleanup).toHaveBeenCalledTimes(1)
  })

  it('stops all timers on stop', async () => {
    const loadConfig = vi.fn(() => ({ refreshInterval: 25, retentionDays: 7 }))
    const runParse = vi.fn(async () => {})
    const runCleanup = vi.fn(() => {})
    const controller = new RuntimeSettingsController({ db: {} as any, loadConfig, runParse, runCleanup, cleanupIntervalMs: 50 })

    controller.start()
    controller.stop()
    await vi.advanceTimersByTimeAsync(500)

    expect(runParse).not.toHaveBeenCalled()
    expect(runCleanup).not.toHaveBeenCalled()
  })

  it('does not schedule when loadConfig returns null', async () => {
    const loadConfig = vi.fn(() => null)
    const runParse = vi.fn(async () => {})
    const runCleanup = vi.fn(() => {})
    const controller = new RuntimeSettingsController({ db: {} as any, loadConfig, runParse, runCleanup })

    controller.start()
    await vi.advanceTimersByTimeAsync(500)

    expect(runParse).not.toHaveBeenCalled()
    expect(runCleanup).not.toHaveBeenCalled()
  })

  it('ignores reload before start', async () => {
    const loadConfig = vi.fn(() => ({ refreshInterval: 25 }))
    const runParse = vi.fn(async () => {})
    const runCleanup = vi.fn(() => {})
    const controller = new RuntimeSettingsController({ db: {} as any, loadConfig, runParse, runCleanup })

    controller.reload()
    await vi.advanceTimersByTimeAsync(100)

    expect(runParse).not.toHaveBeenCalled()
  })

  describe('quota snapshots', () => {
    const base = { db: {} as any, runParse: vi.fn(async () => {}), runCleanup: vi.fn(() => {}) }

    it('schedules on the configured interval', async () => {
      const runQuotaSnapshot = vi.fn(async () => {})
      const controller = new RuntimeSettingsController({
        ...base,
        loadConfig: vi.fn(() => ({ quotaSnapshotInterval: 25 })),
        runQuotaSnapshot,
      })

      controller.start()
      await vi.advanceTimersByTimeAsync(25)
      expect(runQuotaSnapshot).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(25)
      expect(runQuotaSnapshot).toHaveBeenCalledTimes(2)
    })

    it('defaults to a 5-minute interval when unset', async () => {
      const runQuotaSnapshot = vi.fn(async () => {})
      const controller = new RuntimeSettingsController({
        ...base,
        loadConfig: vi.fn(() => ({})),
        runQuotaSnapshot,
      })

      controller.start()
      await vi.advanceTimersByTimeAsync(DEFAULT_QUOTA_SNAPSHOT_INTERVAL_MS - 1)
      expect(runQuotaSnapshot).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(runQuotaSnapshot).toHaveBeenCalledTimes(1)
    })

    it('is disabled by an interval of 0', async () => {
      const runQuotaSnapshot = vi.fn(async () => {})
      const controller = new RuntimeSettingsController({
        ...base,
        loadConfig: vi.fn(() => ({ quotaSnapshotInterval: 0 })),
        runQuotaSnapshot,
      })

      controller.start()
      await vi.advanceTimersByTimeAsync(DEFAULT_QUOTA_SNAPSHOT_INTERVAL_MS * 2)
      expect(runQuotaSnapshot).not.toHaveBeenCalled()
    })

    it('skips overlapping runs', async () => {
      let release!: () => void
      const runQuotaSnapshot = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
      const controller = new RuntimeSettingsController({
        ...base,
        loadConfig: vi.fn(() => ({ quotaSnapshotInterval: 25 })),
        runQuotaSnapshot,
      })

      controller.start()
      await vi.advanceTimersByTimeAsync(25)
      await vi.advanceTimersByTimeAsync(25)
      expect(runQuotaSnapshot).toHaveBeenCalledTimes(1)

      release()
      await vi.advanceTimersByTimeAsync(25)
      expect(runQuotaSnapshot).toHaveBeenCalledTimes(2)
    })

    it('keeps the timer alive after a failure', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const runQuotaSnapshot = vi.fn(async () => { throw new Error('upstream is down') })
      const controller = new RuntimeSettingsController({
        ...base,
        loadConfig: vi.fn(() => ({ quotaSnapshotInterval: 25 })),
        runQuotaSnapshot,
      })

      controller.start()
      await vi.advanceTimersByTimeAsync(25)
      await vi.advanceTimersByTimeAsync(25)

      expect(runQuotaSnapshot).toHaveBeenCalledTimes(2)
      expect(error).toHaveBeenCalled()
    })

    it('stops on stop()', async () => {
      const runQuotaSnapshot = vi.fn(async () => {})
      const controller = new RuntimeSettingsController({
        ...base,
        loadConfig: vi.fn(() => ({ quotaSnapshotInterval: 25 })),
        runQuotaSnapshot,
      })

      controller.start()
      controller.stop()
      await vi.advanceTimersByTimeAsync(500)
      expect(runQuotaSnapshot).not.toHaveBeenCalled()
    })

    it('exposes whether a parse is in flight', async () => {
      let release!: () => void
      const controller = new RuntimeSettingsController({
        ...base,
        loadConfig: vi.fn(() => ({ refreshInterval: 25, quotaSnapshotInterval: 0 })),
        runParse: vi.fn(() => new Promise<void>((resolve) => { release = resolve })),
      })

      controller.start()
      expect(controller.isParseInFlight()).toBe(false)
      await vi.advanceTimersByTimeAsync(25)
      expect(controller.isParseInFlight()).toBe(true)

      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(controller.isParseInFlight()).toBe(false)
      controller.stop()
    })

    it('skips a snapshot while a parse holds the event loop', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      let release!: () => void
      const runQuotaSnapshot = vi.fn(async () => {})
      const controller = new RuntimeSettingsController({
        ...base,
        // Parse fires first and is still running when the snapshot is due.
        loadConfig: vi.fn(() => ({ refreshInterval: 10, quotaSnapshotInterval: 20 })),
        runParse: vi.fn(() => new Promise<void>((resolve) => { release = resolve })),
        runQuotaSnapshot,
      })

      controller.start()
      await vi.advanceTimersByTimeAsync(20)

      expect(runQuotaSnapshot).not.toHaveBeenCalled()
      expect(String(warn.mock.calls[0][0])).toContain('parse in flight')

      release()
      controller.stop()
    })

    it('retries a skipped snapshot once, 30 seconds later', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      let release!: () => void
      let refreshInterval = 10
      let quotaSnapshotInterval = 20
      const runQuotaSnapshot = vi.fn(async () => {})
      const controller = new RuntimeSettingsController({
        ...base,
        loadConfig: vi.fn(() => ({ refreshInterval, quotaSnapshotInterval })),
        runParse: vi.fn(() => new Promise<void>((resolve) => { release = resolve })),
        runQuotaSnapshot,
      })

      controller.start()
      await vi.advanceTimersByTimeAsync(20) // parse at 10 blocks; snapshot at 20 is skipped
      expect(runQuotaSnapshot).not.toHaveBeenCalled()

      // Quiet both intervals so nothing but the pending retry can fire, then
      // let the parse finish. A reload must not cancel the armed retry.
      refreshInterval = 0
      quotaSnapshotInterval = 1_000_000
      controller.reload()
      release()
      await vi.advanceTimersByTimeAsync(0)

      await vi.advanceTimersByTimeAsync(QUOTA_SNAPSHOT_RETRY_DELAY_MS - 1)
      expect(runQuotaSnapshot).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(runQuotaSnapshot).toHaveBeenCalledTimes(1)

      controller.stop()
    })

    it('gives up rather than stacking retries when the parse is still running', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      let release!: () => void
      const runQuotaSnapshot = vi.fn(async () => {})
      const controller = new RuntimeSettingsController({
        ...base,
        // Only the snapshot is scheduled after the first parse, so nothing else
        // can re-arm the retry during this window.
        loadConfig: vi.fn(() => ({ refreshInterval: 10, quotaSnapshotInterval: 20_000 })),
        runParse: vi.fn(() => new Promise<void>((resolve) => { release = resolve })),
        runQuotaSnapshot,
      })

      controller.start()
      await vi.advanceTimersByTimeAsync(10) // parse starts and never finishes
      await vi.advanceTimersByTimeAsync(20_000) // snapshot due → skipped, retry armed
      await vi.advanceTimersByTimeAsync(QUOTA_SNAPSHOT_RETRY_DELAY_MS) // retry → still blocked

      expect(runQuotaSnapshot).not.toHaveBeenCalled()
      expect(String(warn.mock.calls.at(-1)?.[0])).toContain('parse still in flight')

      // No third attempt is queued behind the retry.
      await vi.advanceTimersByTimeAsync(QUOTA_SNAPSHOT_RETRY_DELAY_MS * 5)
      expect(runQuotaSnapshot).not.toHaveBeenCalled()

      release()
      controller.stop()
    })

    it('does not fire a pending retry after stop()', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      let release!: () => void
      const runQuotaSnapshot = vi.fn(async () => {})
      const controller = new RuntimeSettingsController({
        ...base,
        loadConfig: vi.fn(() => ({ refreshInterval: 10, quotaSnapshotInterval: 20 })),
        runParse: vi.fn(() => new Promise<void>((resolve) => { release = resolve })),
        runQuotaSnapshot,
      })

      controller.start()
      await vi.advanceTimersByTimeAsync(20) // skipped, retry armed
      controller.stop()
      release()

      await vi.advanceTimersByTimeAsync(QUOTA_SNAPSHOT_RETRY_DELAY_MS * 3)
      expect(runQuotaSnapshot).not.toHaveBeenCalled()
    })

    it('runs normally when no parse is in flight', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const runQuotaSnapshot = vi.fn(async () => {})
      const controller = new RuntimeSettingsController({
        ...base,
        loadConfig: vi.fn(() => ({ refreshInterval: 0, quotaSnapshotInterval: 20 })),
        runQuotaSnapshot,
      })

      controller.start()
      await vi.advanceTimersByTimeAsync(20)

      expect(runQuotaSnapshot).toHaveBeenCalledTimes(1)
      expect(warn).not.toHaveBeenCalled()
      controller.stop()
    })

    it('does not schedule without a runQuotaSnapshot callback', async () => {
      const controller = new RuntimeSettingsController({
        ...base,
        loadConfig: vi.fn(() => ({ quotaSnapshotInterval: 25 })),
      })

      controller.start()
      // Nothing to assert beyond "this does not throw or leave a live timer".
      await vi.advanceTimersByTimeAsync(500)
      controller.stop()
    })
  })
})

/**
 * Parsing has to happen without anyone watching.
 *
 * Upstream leaves the interval off and lets the dashboard drive a parse when
 * someone opens it, which is coherent for one machine. The spokes run
 * headless and nobody opens their dashboard, and the upload to the hub is
 * driven by the parse — so with no interval a spoke sends its records once at
 * startup and then goes quiet. The laptop did exactly that.
 */
describe('RuntimeSettingsController — parsing without a dashboard', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  const build = (config: Record<string, unknown>) => {
    const runParse = vi.fn(async () => {})
    const controller = new RuntimeSettingsController({
      db: {} as any,
      loadConfig: () => config as any,
      runParse,
      runCleanup: vi.fn(() => {}),
    })
    return { controller, runParse }
  }

  it('parses on a five-minute timer when the config says nothing', async () => {
    const { controller, runParse } = build({})

    controller.start()
    await vi.advanceTimersByTimeAsync(DEFAULT_PARSE_INTERVAL_MS - 1)
    expect(runParse).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(runParse).toHaveBeenCalledTimes(1)

    // And keeps going, rather than firing once.
    await vi.advanceTimersByTimeAsync(DEFAULT_PARSE_INTERVAL_MS)
    expect(runParse).toHaveBeenCalledTimes(2)
  })

  it('stays off when the interval is explicitly zero', async () => {
    const { controller, runParse } = build({ refreshInterval: 0 })

    controller.start()
    await vi.advanceTimersByTimeAsync(DEFAULT_PARSE_INTERVAL_MS * 3)

    // The escape hatch has to keep working: someone who turned this off
    // deliberately must not have it turned back on by an upgrade.
    expect(runParse).not.toHaveBeenCalled()
  })

  it('uses the configured interval when there is one', async () => {
    const { controller, runParse } = build({ refreshInterval: 60_000 })

    controller.start()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(runParse).toHaveBeenCalledTimes(1)
  })

  it('still honours the older parseInterval name', async () => {
    const { controller, runParse } = build({ parseInterval: 30_000 })

    controller.start()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(runParse).toHaveBeenCalledTimes(1)
  })

  it('prefers refreshInterval when both are set', async () => {
    const { controller, runParse } = build({ refreshInterval: 10_000, parseInterval: 90_000 })

    controller.start()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(runParse).toHaveBeenCalledTimes(1)
  })

  /**
   * Once the timer exists, a failing parse must say so. Nothing was logged
   * during the incident, and the reason turned out to be that nothing ran —
   * so this pins down the case where something does run and throws.
   */
  it('logs when a parse throws, rather than failing silently', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const controller = new RuntimeSettingsController({
      db: {} as any,
      loadConfig: () => ({}) as any,
      runParse: vi.fn(async () => { throw new Error('disk on fire') }),
      runCleanup: vi.fn(() => {}),
    })

    controller.start()
    await vi.advanceTimersByTimeAsync(DEFAULT_PARSE_INTERVAL_MS)

    expect(error).toHaveBeenCalled()
    expect(error.mock.calls.flat().join(' ')).toContain('parse failed')
  })

  it('keeps parsing after one throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const runParse = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(undefined)
    const controller = new RuntimeSettingsController({
      db: {} as any,
      loadConfig: () => ({}) as any,
      runParse,
      runCleanup: vi.fn(() => {}),
    })

    controller.start()
    await vi.advanceTimersByTimeAsync(DEFAULT_PARSE_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(DEFAULT_PARSE_INTERVAL_MS)

    // A failure must not leave parseInFlight stuck and silence every tick
    // after it — that shape is exactly what an outage looks like from here.
    expect(runParse).toHaveBeenCalledTimes(2)
  })
})
