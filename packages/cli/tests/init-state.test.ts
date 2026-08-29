import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { ensureAiusageDir, getState, getIngestToken } from '../src/init.js'
import { initializeDatabase } from '../src/db/index.js'
import { findPredominantDeviceInstanceId, insertRecord } from '../src/db/records.js'
import type { StatsRecord } from '@aiusage/core'

/**
 * state.json was never being created — nothing called ensureAiusageDir — so
 * the ingest token was always null and every hook POST got a 401. These tests
 * cover the fix, and in particular the rule that the device instance id is
 * adopted from the existing records rather than invented.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aiusage-state-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function readState() {
  return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8'))
}

function makeDb(deviceIds: string[]): Database.Database {
  const db = new Database(':memory:')
  initializeDatabase(db)
  deviceIds.forEach((deviceInstanceId, i) => {
    insertRecord(db, {
      id: `r${i}`, ts: 1000 + i, ingestedAt: 1000, updatedAt: 1000, lineOffset: i,
      tool: 'claude-code', model: 'm', provider: 'anthropic',
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
      thinkingTokens: 0, cost: 0, costSource: 'pricing', sessionId: `s${i}`,
      sourceFile: `/f${i}`, device: 'host', deviceInstanceId,
    } as StatsRecord)
  })
  return db
}

describe('ensureAiusageDir', () => {
  it('generates both ids when there is no state and no records', () => {
    const db = makeDb([])
    const result = ensureAiusageDir(dir, () => findPredominantDeviceInstanceId(db))
    db.close()

    expect(result.created).toBe(true)
    expect(result.deviceInstanceIdSource).toBe('generated')
    expect(result.ingestTokenAdded).toBe(true)

    const state = readState()
    expect(state.deviceInstanceId).toMatch(/^[0-9a-f-]{36}$/)
    expect(state.ingestToken).toMatch(/^[0-9a-f-]{36}$/)
    expect(state.lastSyncStatus).toBe('ok')
  })

  /**
   * The production database carries device_instance_id 'unknown' on every
   * record, because the fallback ran for months. Minting a UUID here would
   * break the v_agent_sessions join and change every future record id.
   */
  it('adopts the id the existing records use, however ugly it looks', () => {
    const db = makeDb(Array(10).fill('unknown'))
    const result = ensureAiusageDir(dir, () => findPredominantDeviceInstanceId(db))
    db.close()

    expect(result.deviceInstanceIdSource).toBe('existing_records')
    expect(result.deviceInstanceId).toBe('unknown')
    expect(readState().deviceInstanceId).toBe('unknown')
    // The token is unrelated to stored data, so it is still fresh.
    expect(readState().ingestToken).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('follows the majority when records carry more than one id', () => {
    const db = makeDb(['device-a', 'device-a', 'device-a', 'device-b'])
    const result = ensureAiusageDir(dir, () => findPredominantDeviceInstanceId(db))
    db.close()

    expect(result.deviceInstanceId).toBe('device-a')
    expect(result.deviceInstanceIdSource).toBe('existing_records')
  })

  it('adds only the token to an existing state file', () => {
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({ deviceInstanceId: 'already-here', lastSyncStatus: 'ok' }),
      'utf-8',
    )
    const db = makeDb(['something-else'])
    const result = ensureAiusageDir(dir, () => findPredominantDeviceInstanceId(db))
    db.close()

    expect(result.created).toBe(false)
    expect(result.ingestTokenAdded).toBe(true)
    // Never rewritten from the database once a state file exists.
    expect(readState().deviceInstanceId).toBe('already-here')
    expect(readState().ingestToken).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('changes nothing when the state file is already complete', () => {
    const state = { deviceInstanceId: 'stable', ingestToken: 'token-abc', lastSyncStatus: 'ok' }
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state), 'utf-8')

    const result = ensureAiusageDir(dir, () => 'ignored')
    expect(result.created).toBe(false)
    expect(result.ingestTokenAdded).toBe(false)
    expect(readState()).toEqual(state)

    // Idempotent: running it again is still a no-op.
    ensureAiusageDir(dir, () => 'ignored')
    expect(readState()).toEqual(state)
  })

  it('works without a resolver, for callers that have no database', () => {
    const result = ensureAiusageDir(dir)
    expect(result.created).toBe(true)
    expect(result.deviceInstanceIdSource).toBe('generated')
  })

  it('makes the ingest token readable, which is what the 401 came down to', () => {
    delete process.env.AIUSAGE_INGEST_TOKEN
    expect(getIngestToken(dir)).toBeNull()

    ensureAiusageDir(dir)
    const token = getIngestToken(dir)
    expect(token).toBeTruthy()
    expect(token).toBe(getState(dir)?.ingestToken)
  })
})

describe('findPredominantDeviceInstanceId', () => {
  it('returns null for an empty database', () => {
    const db = makeDb([])
    expect(findPredominantDeviceInstanceId(db)).toBeNull()
    db.close()
  })

  it('returns the only id when there is one', () => {
    const db = makeDb(['solo', 'solo'])
    expect(findPredominantDeviceInstanceId(db)).toBe('solo')
    db.close()
  })
})
