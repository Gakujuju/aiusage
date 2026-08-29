import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RuntimeSettingsController, DEFAULT_QUOTA_SNAPSHOT_INTERVAL_MS } from '../../src/runtime/settings-controller.js'

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

  it('does not schedule when refreshInterval is blank or zero', async () => {
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
