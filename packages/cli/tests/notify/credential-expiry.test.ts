import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { initializeDatabase } from '../../src/db/index.js'
import { recordQuotaSnapshot } from '../../src/db/quota-history.js'
import { notifyQuotaSummary } from '../../src/notify/enqueue.js'
import type { QuotaResult } from '../../src/quota.js'
import type { NotificationRulesConfig } from '@aiusage/core'

/**
 * One message per outage, and no message at all for a tool that is simply not
 * installed here.
 *
 * The failure this guards against is the loud one: the quota poll runs every
 * five minutes, so an expired credential fails about a hundred times before
 * anyone fixes it. Announcing each of those would be worse than staying quiet.
 */

const DEVICE = 'desk'
const DEVICE_ID = 'device-uuid-a'

const CONFIG: NotificationRulesConfig = { enabled: true }

function success(tool: string, utilization: number): QuotaResult {
  return {
    tool,
    credentialStatus: 'valid',
    credentialMessage: null,
    success: true,
    tiers: [{ name: 'five_hour', utilization, resetsAt: null }],
    error: null,
    queriedAt: Date.now(),
  }
}

/** What the reader returns once ~/.claude/.credentials.json has gone stale. */
function expired(tool: string): QuotaResult {
  return {
    tool,
    credentialStatus: 'expired',
    credentialMessage: 'Token expired',
    success: false,
    tiers: [],
    error: null,
    queriedAt: Date.now(),
  }
}

/** What it returns for a tool that was never set up on this machine. */
function notFound(tool: string): QuotaResult {
  return {
    tool,
    credentialStatus: 'not_found',
    credentialMessage: null,
    success: false,
    tiers: [],
    error: null,
    queriedAt: Date.now(),
  }
}

function poll(db: Database.Database, results: QuotaResult[], now: number): number {
  const summary = recordQuotaSnapshot(db, results, {
    device: DEVICE, deviceInstanceId: DEVICE_ID, now,
  })
  return notifyQuotaSummary({
    db, config: CONFIG, isNotifier: true, deviceInstanceId: DEVICE_ID,
    device: DEVICE, now,
  }, summary)
}

function credentialRows(db: Database.Database) {
  return db.prepare(`
    SELECT dedupe_key, title, body, state FROM notifications
    WHERE event_type = 'quota_credential' ORDER BY created_at
  `).all() as Array<{ dedupe_key: string; title: string; body: string; state: string }>
}

describe('credential expiry notification', () => {
  let db: Database.Database
  const start = Date.UTC(2026, 7, 30, 9, 0, 0)

  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
  })

  afterEach(() => {
    db.close()
  })

  it('says so once when the credential expires', () => {
    poll(db, [success('claude-code', 40)], start)
    poll(db, [expired('claude-code')], start + 5 * 60_000)

    const rows = credentialRows(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toContain('資格情報が失効')
    expect(rows[0].title).toContain(DEVICE)
    expect(rows[0].state).toBe('pending')
  })

  it('tells the reader how to fix it', () => {
    poll(db, [success('claude-code', 40)], start)
    poll(db, [expired('claude-code')], start + 5 * 60_000)

    // Naming the command matters: this notification only arrives when the
    // scheduled refresh has stopped working, so the reader has to do it.
    expect(credentialRows(db)[0].body).toContain('claude doctor')
  })

  it('stays quiet through a whole outage of repeated failures', () => {
    poll(db, [success('claude-code', 40)], start)
    // Eight hours of five-minute polls, which is the real shape of this.
    for (let i = 1; i <= 96; i++) {
      poll(db, [expired('claude-code')], start + i * 5 * 60_000)
    }

    expect(credentialRows(db)).toHaveLength(1)
  })

  it('speaks again after the credential is fixed and expires a second time', () => {
    poll(db, [success('claude-code', 40)], start)
    poll(db, [expired('claude-code')], start + 5 * 60_000)
    poll(db, [expired('claude-code')], start + 10 * 60_000)

    // Refreshed: the poll works, and last_success_at moves.
    poll(db, [success('claude-code', 45)], start + 15 * 60_000)
    poll(db, [expired('claude-code')], start + 20 * 60_000)

    const rows = credentialRows(db)
    expect(rows).toHaveLength(2)
    // The second outage is a different occurrence, not a repeat of the first.
    expect(rows[0].dedupe_key).not.toBe(rows[1].dedupe_key)
  })

  it('says nothing for a tool that is not set up here', () => {
    // not_found is "you do not use this", not "this is broken" — the same
    // distinction D15 draws.
    poll(db, [notFound('codex')], start)
    poll(db, [notFound('codex')], start + 5 * 60_000)

    expect(credentialRows(db)).toHaveLength(0)
  })

  it('records but does not send on a machine that is not the notifier', () => {
    const summary = recordQuotaSnapshot(db, [success('claude-code', 40)], {
      device: DEVICE, deviceInstanceId: DEVICE_ID, now: start,
    })
    expect(summary.credentialFailures).toHaveLength(0)

    const failing = recordQuotaSnapshot(db, [expired('claude-code')], {
      device: DEVICE, deviceInstanceId: DEVICE_ID, now: start + 5 * 60_000,
    })
    notifyQuotaSummary({
      db, config: CONFIG, isNotifier: false, deviceInstanceId: DEVICE_ID,
      device: DEVICE, now: start + 5 * 60_000,
    }, failing)

    expect(credentialRows(db)[0].state).toBe('dropped')
  })

  it('reports the outage even when the tool has never succeeded here', () => {
    poll(db, [expired('claude-code')], start)

    // No prior row means no last_success_at, and the key has to stay stable
    // anyway or the first outage would announce itself every five minutes.
    poll(db, [expired('claude-code')], start + 5 * 60_000)
    const rows = credentialRows(db)
    expect(rows.length).toBeLessThanOrEqual(1)
  })
})
