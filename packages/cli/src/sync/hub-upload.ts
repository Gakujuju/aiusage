import type Database from 'better-sqlite3'
import { HUB_FORWARD_TOKEN_CREDENTIAL, loadConfig, loadCredential } from '../config.js'
import { getUnsyncedRecords, markRecordsSynced } from '../db/records.js'
import { mapStatsRecordToSyncRecord } from './mapper.js'
import { chunkByLimits, MAX_SYNC_RECORDS_PER_REQUEST } from './direct.js'

/**
 * Sending this machine's usage records to the hub.
 *
 * One direction. The hub adds up what every machine produces; nothing comes
 * back, and deletions are not propagated (D25). What arrives goes into
 * synced_records, which serve already merges into records — so a record from
 * the work laptop reaches the dashboard by the same path a record pulled from
 * GitHub always has.
 *
 * The interesting part is not the HTTP. It is that the watermark is per
 * destination: sync_record_state is keyed on (record_id, target), so a
 * machine can upload to the hub and to a GitHub repository without either one
 * marking records the other has not sent.
 */

/** Ten seconds. Longer than a hook is allowed, because nothing is waiting. */
const UPLOAD_TIMEOUT_MS = 10_000

/**
 * Twenty minutes.
 *
 * The reason to send often is the dashboard being current; the reason not to
 * is that every upload is a write on the receiving machine. Agent events —
 * the thing anyone actually watches in real time — already arrive within a
 * second of happening over their own path, so records are the slower,
 * cheaper half and do not need to keep pace with them. Twenty minutes also
 * sits comfortably above the default five-minute parse, so a batch is
 * normally several parses' worth rather than a handful of rows.
 */
export const DEFAULT_HUB_UPLOAD_INTERVAL_MS = 20 * 60 * 1000

export interface HubUploadResult {
  sent: number
  batches: number
  /** Why nothing was attempted, when that is the answer. */
  skipped: 'no_hub' | 'no_token' | 'nothing_to_send' | null
  error?: string
}

/**
 * Which watermark column this destination writes to.
 *
 * Prefixed so it cannot collide with a GitHub repository name or an S3
 * bucket, both of which are also used as targets.
 */
export function hubTarget(origin: string): string {
  return `direct:${origin}`
}

/** The hub's origin, or null when this machine is not reporting to one. */
export function hubOrigin(): string | null {
  const url = loadConfig()?.hubForward?.url?.trim()
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

export interface HubUploadDeps {
  db: Database.Database
  runDbWrite: <T>(fn: () => T) => Promise<T>
  fetchImpl?: typeof fetch
  now?: () => number
}

/**
 * One upload pass. Never throws — a hub that is asleep is not an error, and
 * the records stay unsent until it is not.
 */
export async function runHubUpload(deps: HubUploadDeps): Promise<HubUploadResult> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const result: HubUploadResult = { sent: 0, batches: 0, skipped: null }

  const origin = hubOrigin()
  if (!origin) return { ...result, skipped: 'no_hub' }

  const token = loadCredential(HUB_FORWARD_TOKEN_CREDENTIAL)
  if (!token) return { ...result, skipped: 'no_token' }

  const target = hubTarget(origin)
  const unsynced = getUnsyncedRecords(deps.db, target)
  if (unsynced.length === 0) return { ...result, skipped: 'nothing_to_send' }

  /*
   * Both ids travel together. mapStatsRecordToSyncRecord derives the id that
   * goes on the wire from (device, source file, line offset), which for most
   * tools is not the local row's id — so marking the watermark with what was
   * sent would name rows that do not exist here. sync_record_state has a
   * foreign key onto records, so that mistake fails loudly rather than
   * quietly losing the watermark, which is how it was caught.
   */
  const pairs = unsynced.map((local) => ({ localId: local.id, wire: mapStatsRecordToSyncRecord(local) }))
  const batches = chunkByLimits(pairs, (p) => Buffer.byteLength(JSON.stringify(p.wire)))

  for (const batch of batches) {
    let ok = false
    try {
      const response = await fetchImpl(`${origin}/api/sync/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Aiusage-Token': token },
        body: JSON.stringify({ records: batch.map((p) => p.wire) }),
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      })
      ok = response.ok
      if (!ok) {
        // 413 means the two sides disagree about the limits, which is a
        // version skew rather than something to retry into forever. Reported
        // rather than swallowed; the records stay unsent either way.
        result.error = response.status === 413
          ? `hub rejected a batch of ${batch.length} as too large (limit here is ${MAX_SYNC_RECORDS_PER_REQUEST})`
          : `HTTP ${response.status}`
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error)
    }

    // Stop at the first failure rather than pushing the rest at a hub that
    // just refused one. The watermark has not moved, so the next pass starts
    // from the same place.
    if (!ok) break

    // Marked only after the hub has taken them. A crash between the post and
    // this line resends the batch, which insertSyncedRecord treats as a
    // no-op.
    await deps.runDbWrite(() => markRecordsSynced(deps.db, batch.map((p) => p.localId), now(), target))
    result.sent += batch.length
    result.batches++
  }

  return result
}
