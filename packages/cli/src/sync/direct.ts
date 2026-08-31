import type { SyncRecord } from '@aiusage/core'

/**
 * Records handed straight from one install to another over the tailnet.
 *
 * The alternative was a shared GitHub repository, which meant the working
 * directory and log path of every session leaving the machine and living on
 * someone else's server. This keeps them between two machines the same person
 * runs. See D26 for the comparison.
 *
 * The limits live here rather than in the server so the sender splits at the
 * same boundary the receiver enforces, instead of discovering it as a 413.
 */

/**
 * Two ceilings, because either can be reached first: many small records, or
 * a few carrying long absolute paths. 500 records of ordinary size is well
 * under the byte limit, so in practice the count is what bites — which is the
 * cheaper one for the sender to reason about.
 */
export const MAX_SYNC_RECORDS_PER_REQUEST = 500
export const MAX_SYNC_PAYLOAD_BYTES = 4_000_000

/** A field that must be a string to be usable, with a default for the rest. */
function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  // Timestamps survive JSON as strings in some of the older sync paths, so a
  // numeric string is accepted rather than silently becoming zero.
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
    const asDate = Date.parse(value)
    if (Number.isFinite(asDate)) return asDate
  }
  return fallback
}

/**
 * Turn one item of an incoming payload into a record, or reject it.
 *
 * Anything arriving here came over the network from another machine, so the
 * shape is checked rather than assumed. Only the fields that make a record
 * identifiable are required; the rest have defaults, because a record with a
 * missing token count is still worth counting as a session and a rejected one
 * is worth nothing.
 */
export function normalizeIncomingSyncRecord(raw: unknown): SyncRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>

  const id = str(r.id)
  const tool = str(r.tool)
  const deviceInstanceId = str(r.deviceInstanceId)
  const ts = num(r.ts, NaN)
  // Without these the row cannot be identified, deduplicated, or attributed
  // to a machine, which is the whole point of accepting it.
  if (!id || !tool || !deviceInstanceId || !Number.isFinite(ts)) return null

  return {
    id,
    ts,
    tool: tool as SyncRecord['tool'],
    model: str(r.model),
    provider: str(r.provider),
    inputTokens: num(r.inputTokens),
    outputTokens: num(r.outputTokens),
    cacheReadTokens: num(r.cacheReadTokens),
    cacheWriteTokens: num(r.cacheWriteTokens),
    thinkingTokens: num(r.thinkingTokens),
    cost: num(r.cost),
    costSource: str(r.costSource, 'pricing') as SyncRecord['costSource'],
    sessionKey: str(r.sessionKey),
    device: str(r.device),
    deviceInstanceId,
    platform: str(r.platform),
    // Falling back to the arrival time would make a record look newer than it
    // is and let it overwrite a good row, so an unusable value stays 0 and
    // loses every comparison instead.
    updatedAt: num(r.updatedAt, 0),
    sourceFile: str(r.sourceFile),
    cwd: str(r.cwd),
  }
}

/**
 * Split a list so neither ceiling is crossed.
 *
 * Generic over the item because the uploader has to carry two ids per
 * record — the one that goes on the wire and the local one the watermark is
 * keyed on — and splitting the wire records alone would leave it guessing
 * which local rows a batch covered.
 */
export function chunkByLimits<T>(items: T[], sizeOf: (item: T) => number): T[][] {
  const batches: T[][] = []
  let current: T[] = []
  let bytes = 0

  for (const item of items) {
    // +1 for the comma this item adds to the array once serialised. The
    // envelope around it is a few dozen bytes, far inside the margin between
    // the count limit and the byte limit.
    const size = sizeOf(item) + 1

    if (current.length > 0 && (current.length >= MAX_SYNC_RECORDS_PER_REQUEST || bytes + size > MAX_SYNC_PAYLOAD_BYTES)) {
      batches.push(current)
      current = []
      bytes = 0
    }
    current.push(item)
    bytes += size
  }

  if (current.length > 0) batches.push(current)
  return batches
}

/** Split a batch of records so neither ceiling is crossed. */
export function chunkSyncRecords(records: SyncRecord[]): SyncRecord[][] {
  return chunkByLimits(records, (r) => Buffer.byteLength(JSON.stringify(r)))
}
