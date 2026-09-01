import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { initializeDatabase } from '../../src/db/index.js'
import { recordHeartbeat, hubHealth, DEFAULT_SILENCE_HOURS } from '../../src/db/heartbeats.js'

/**
 * Telling a spoke that stopped from one that had nothing to say.
 *
 * From the last record alone those are the same silence, and only one of
 * them is a problem — the same ambiguity the parse detector was built to
 * remove, one level up. The cure is the same too: stop being silent. A spoke
 * reports in whether or not it had anything to send, so an absence of
 * reports means something.
 *
 * No notification is sent for any of this. Nobody has measured what a normal
 * silence looks like on these machines, and picking a threshold without that
 * would be inventing a number — the same mistake as pricing a model whose
 * rate nobody publishes. These figures are what will make it choosable.
 */

const HOUR = 3600_000
let db: Database.Database

const beat = (overrides: Partial<Parameters<typeof recordHeartbeat>[1]> = {}) => ({
  deviceInstanceId: 'spoke-1',
  device: 'work',
  lastHeartbeatAt: 1_000_000,
  lastRecordsSent: 0,
  lastParseOkAt: null,
  commit: null,
  commitTime: null,
  ...overrides,
})

describe('the hub can tell a quiet spoke from a stopped one', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
  })

  afterEach(() => {
    db.close()
  })

  it('records a machine that reported in with nothing to send', () => {
    // The case the whole thing exists for: alive, and silent for good reason.
    recordHeartbeat(db, beat({ lastRecordsSent: 0 }))

    const [spoke] = hubHealth(db, { now: () => 1_000_000 + HOUR })

    expect(spoke.silent).toBe(false)
    expect(spoke.lastRecordsSent).toBe(0)
  })

  it('says nothing about a machine that has never reported', () => {
    // An older spoke is unknown, not broken. Calling it broken would invent
    // an outage out of a version difference.
    expect(hubHealth(db)).toEqual([])
  })

  it('calls a machine silent once it passes its own threshold', () => {
    recordHeartbeat(db, beat())

    const [spoke] = hubHealth(db, {
      silenceHours: { 'spoke-1': 24 },
      now: () => 1_000_000 + 25 * HOUR,
    })

    expect(spoke.silent).toBe(true)
    expect(spoke.silentSince).toBe(1_000_000)
    expect(spoke.thresholdHours).toBe(24)
  })

  it('holds its peace right up to the threshold', () => {
    recordHeartbeat(db, beat())

    const [spoke] = hubHealth(db, {
      silenceHours: { 'spoke-1': 24 },
      now: () => 1_000_000 + 24 * HOUR,
    })

    expect(spoke.silent).toBe(false)
  })

  it('gives each machine its own budget', () => {
    // A work computer is meant to be quiet all weekend; a laptop may go a
    // week unopened. One threshold cannot describe both.
    recordHeartbeat(db, beat({ deviceInstanceId: 'work', device: 'work' }))
    recordHeartbeat(db, beat({ deviceInstanceId: 'laptop', device: 'laptop' }))

    const health = hubHealth(db, {
      silenceHours: { work: 24, laptop: 168 },
      now: () => 1_000_000 + 48 * HOUR,
    })

    expect(health.find((s) => s.deviceInstanceId === 'work')?.silent).toBe(true)
    expect(health.find((s) => s.deviceInstanceId === 'laptop')?.silent).toBe(false)
  })

  it('falls back to a generous default when none is configured', () => {
    recordHeartbeat(db, beat())

    const [spoke] = hubHealth(db, { now: () => 1_000_000 + 48 * HOUR })

    expect(spoke.thresholdHours).toBe(DEFAULT_SILENCE_HOURS)
    // A week of grace, because the right number is not known yet and a
    // false alarm now would teach people to ignore the real one later.
    expect(spoke.silent).toBe(false)
  })

  it('keeps one row per machine, not one per report', () => {
    recordHeartbeat(db, beat({ lastHeartbeatAt: 1_000_000, lastRecordsSent: 5 }))
    recordHeartbeat(db, beat({ lastHeartbeatAt: 2_000_000, lastRecordsSent: 0 }))

    const health = hubHealth(db, { now: () => 2_000_000 })

    expect(health).toHaveLength(1)
    expect(health[0].lastHeartbeatAt).toBe(2_000_000)
    expect(health[0].lastRecordsSent).toBe(0)
  })

  /*
   * Three machines are updated by hand, and what actually goes wrong is
   * forgetting which ones were done. The hub decides this once so that no
   * two readers can compare the same two builds and disagree.
   */
  describe('which machines are running older code than the hub', () => {
    const HUB = { commit: 'bbbbbbb', commitTime: 2_000 }

    it('says so when a machine is older', () => {
      recordHeartbeat(db, beat({ commit: 'aaaaaaa', commitTime: 1_000 }))

      const [spoke] = hubHealth(db, { hub: HUB, now: () => 1_000_000 })

      expect(spoke.behind).toBe(true)
      expect(spoke.commit).toBe('aaaaaaa')
    })

    it('says so when a machine is up to date', () => {
      recordHeartbeat(db, beat({ commit: 'bbbbbbb', commitTime: 2_000 }))

      expect(hubHealth(db, { hub: HUB, now: () => 1_000_000 })[0].behind).toBe(false)
    })

    it('leaves it unknown when the spoke cannot say', () => {
      // An older spoke sends no version at all. Unknown must not become
      // "out of date": that would turn a missing value into a verdict.
      recordHeartbeat(db, beat())

      expect(hubHealth(db, { hub: HUB, now: () => 1_000_000 })[0].behind).toBe(null)
    })

    it('leaves it unknown when the hub cannot say', () => {
      // A hub running from source, or built without git, knows nothing to
      // measure against — and cannot therefore convict anyone.
      recordHeartbeat(db, beat({ commit: 'aaaaaaa', commitTime: 1_000 }))

      const [spoke] = hubHealth(db, {
        hub: { commit: null, commitTime: null },
        now: () => 1_000_000,
      })

      expect(spoke.behind).toBe(null)
    })

    it('leaves it unknown when nobody passed the hub a version', () => {
      recordHeartbeat(db, beat({ commit: 'aaaaaaa', commitTime: 1_000 }))

      expect(hubHealth(db, { now: () => 1_000_000 })[0].behind).toBe(null)
    })

    it('does not call a newer machine behind', () => {
      // Only older, not merely different. A machine ahead of the hub is a
      // different situation and not the one this answers.
      recordHeartbeat(db, beat({ commit: 'ccccccc', commitTime: 3_000 }))

      expect(hubHealth(db, { hub: HUB, now: () => 1_000_000 })[0].behind).toBe(false)
    })
  })

  it('carries what the spoke said about its own parsing', () => {
    // So the hub can tell "not sending" from "sending, but its parsing
    // stopped" — two different faults that look alike from here.
    recordHeartbeat(db, beat({ lastParseOkAt: 999_000 }))

    expect(hubHealth(db, { now: () => 1_000_000 })[0].lastParseOkAt).toBe(999_000)
  })
})
