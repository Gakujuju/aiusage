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
  /*
   * The detector.
   *
   * A clock is injected rather than left to the fake timers alone, because
   * the thing under test is the gap between two readings of it, and the
   * production clock does not advance when vitest advances a timer.
   */
  describe('parse stall detection', () => {
    /** Never resolves: a parse that started and never came back. */
    const hungParse = () => new Promise<void>(() => {})

    function build(overrides: Record<string, unknown> = {}) {
      let clock = 1_000_000
      const onParseStalled = vi.fn()
      const controller = new RuntimeSettingsController({
        db: {} as any,
        loadConfig: () => ({}) as any,
        runParse: vi.fn(async () => {}),
        runCleanup: vi.fn(() => {}),
        onParseStalled,
        now: () => clock,
        ...overrides,
      } as any)
      return {
        controller,
        onParseStalled,
        advanceClock: (ms: number) => { clock += ms },
        get clock() { return clock },
      }
    }

    it('says nothing while parses keep completing', async () => {
      const h = build()
      h.controller.start()

      // Four parses, each on time. The clock moves only in step with them.
      for (let i = 0; i < 4; i++) {
        h.advanceClock(DEFAULT_PARSE_INTERVAL_MS)
        await vi.advanceTimersByTimeAsync(DEFAULT_PARSE_INTERVAL_MS)
      }

      expect(h.onParseStalled).not.toHaveBeenCalled()
      expect(h.controller.parseHealth().stalled).toBe(false)
      h.controller.stop()
    })

    it('reports once after three intervals of silence', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const h = build({ runParse: vi.fn(hungParse) })
      h.controller.start()

      h.advanceClock(DEFAULT_PARSE_INTERVAL_MS * 3)
      await vi.advanceTimersByTimeAsync(DEFAULT_PARSE_INTERVAL_MS * 3)
      // Exactly three intervals is not yet more than three.
      expect(h.onParseStalled).not.toHaveBeenCalled()

      h.advanceClock(60_000)
      await vi.advanceTimersByTimeAsync(60_000)

      expect(h.onParseStalled).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalled()
      h.controller.stop()
    })

    it('does not say it again while the same silence continues', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const h = build({ runParse: vi.fn(hungParse) })
      h.controller.start()

      // Long past the threshold, and then a good while longer.
      h.advanceClock(DEFAULT_PARSE_INTERVAL_MS * 10)
      await vi.advanceTimersByTimeAsync(DEFAULT_PARSE_INTERVAL_MS * 10)

      expect(h.onParseStalled).toHaveBeenCalledTimes(1)
      h.controller.stop()
    })

    /*
     * A failing parse rather than a hanging one, because a hang cannot
     * recover: the run that never returns leaves parseInFlight set, so every
     * later tick returns early and nothing can put it right short of a
     * restart. Failure is the recoverable kind, and the kind worth testing
     * here.
     */
    it('reports again after a recovery and a second silence', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(console, 'error').mockImplementation(() => {})
      let failing = true
      const h = build({
        runParse: vi.fn(async () => { if (failing) throw new Error('down') }),
      })
      h.controller.start()

      h.advanceClock(DEFAULT_PARSE_INTERVAL_MS * 4)
      await vi.advanceTimersByTimeAsync(DEFAULT_PARSE_INTERVAL_MS * 4)
      expect(h.onParseStalled).toHaveBeenCalledTimes(1)
      const firstStart = h.onParseStalled.mock.calls[0][0].stalledSince

      // It comes back.
      failing = false
      h.advanceClock(DEFAULT_PARSE_INTERVAL_MS)
      await vi.advanceTimersByTimeAsync(DEFAULT_PARSE_INTERVAL_MS)
      expect(h.controller.parseHealth().stalled).toBe(false)

      // And stops again. A different outage, so it is said again — and the
      // start time differs, which is what stops the dedupe key swallowing it.
      failing = true
      h.advanceClock(DEFAULT_PARSE_INTERVAL_MS * 4)
      await vi.advanceTimersByTimeAsync(DEFAULT_PARSE_INTERVAL_MS * 4)

      expect(h.onParseStalled).toHaveBeenCalledTimes(2)
      expect(h.onParseStalled.mock.calls[1][0].stalledSince).not.toBe(firstStart)
      h.controller.stop()
    })

    /**
     * The point of the separate timer.
     *
     * With parsing switched off there is nothing to be silent about, so the
     * case that matters is a parse timer that exists and never comes back.
     * Here the parse hangs forever: its callback never returns, which is
     * precisely the shape that would take the detector down with it if the
     * two shared a timer.
     */
    it('still reports when the parse itself is what is stuck', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const h = build({ runParse: vi.fn(hungParse) })
      h.controller.start()

      h.advanceClock(DEFAULT_PARSE_INTERVAL_MS * 4)
      await vi.advanceTimersByTimeAsync(DEFAULT_PARSE_INTERVAL_MS * 4)

      expect(h.onParseStalled).toHaveBeenCalledTimes(1)
      h.controller.stop()
    })

    /**
     * Config is reloadable, so a threshold frozen at startup would be wrong
     * from the moment someone changed the interval — crying wolf if they
     * slowed it down, staying quiet for hours if they sped it up.
     */
    it('moves the threshold when the interval changes', async () => {
      let refreshInterval = DEFAULT_PARSE_INTERVAL_MS
      const h = build({
        loadConfig: () => ({ refreshInterval }) as any,
        runParse: vi.fn(hungParse),
      })
      h.controller.start()

      // Twelve minutes of silence: past 3x a one-minute interval, nowhere
      // near 3x five minutes.
      h.advanceClock(12 * 60_000)
      expect(h.controller.parseHealth().stalled).toBe(false)

      refreshInterval = 60_000
      h.controller.reload()

      const health = h.controller.parseHealth()
      expect(health.intervalMs).toBe(60_000)
      expect(health.thresholdMs).toBe(3 * 60_000)
      expect(health.stalled).toBe(true)
      h.controller.stop()
    })

    it('reports when a parse last completed', async () => {
      const h = build()
      h.controller.start()
      const startedAt = h.clock

      h.advanceClock(DEFAULT_PARSE_INTERVAL_MS)
      await vi.advanceTimersByTimeAsync(DEFAULT_PARSE_INTERVAL_MS)

      expect(h.controller.parseHealth().lastParseOkAt).toBe(startedAt + DEFAULT_PARSE_INTERVAL_MS)
      h.controller.stop()
    })

    /** A parse that threw leaves the data as stale as one that never ran. */
    it('does not count a failed parse as a completed one', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const h = build({ runParse: vi.fn(async () => { throw new Error('disk on fire') }) })
      h.controller.start()
      const startedAt = h.clock

      h.advanceClock(DEFAULT_PARSE_INTERVAL_MS * 4)
      await vi.advanceTimersByTimeAsync(DEFAULT_PARSE_INTERVAL_MS * 4)

      expect(h.controller.parseHealth().lastParseOkAt).toBe(startedAt)
      expect(h.onParseStalled).toHaveBeenCalledTimes(1)
      h.controller.stop()
    })

    it('is not stalled when parsing is switched off on purpose', async () => {
      const h = build({ loadConfig: () => ({ refreshInterval: 0 }) as any })
      h.controller.start()

      h.advanceClock(DEFAULT_PARSE_INTERVAL_MS * 100)
      await vi.advanceTimersByTimeAsync(DEFAULT_PARSE_INTERVAL_MS * 100)

      expect(h.controller.parseHealth().stalled).toBe(false)
      expect(h.onParseStalled).not.toHaveBeenCalled()
      h.controller.stop()
    })
  })
})
