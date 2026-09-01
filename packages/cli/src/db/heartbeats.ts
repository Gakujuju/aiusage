import type Database from 'better-sqlite3'

/**
 * Which machines are still talking to this one, and which have gone quiet.
 *
 * Deliberately separate from the parse-stall detector even though the shape
 * rhymes. That one watches a single thing against a threshold derived from
 * its own interval; this watches N machines against a threshold set per
 * machine, because what counts as a normal silence differs by machine and
 * cannot be derived from anything the hub knows. A work computer is
 * meant to be quiet all weekend. A laptop may not be opened for a week.
 */

export interface Heartbeat {
  deviceInstanceId: string
  device: string
  lastHeartbeatAt: number
  lastRecordsSent: number
  lastParseOkAt: number | null
}

export interface SpokeHealth extends Heartbeat {
  /** How long this machine may stay quiet before it is worth remarking on. */
  thresholdHours: number
  silent: boolean
  /** When the current silence began, or null while it is within bounds. */
  silentSince: number | null
}

/**
 * How long a machine may be quiet before anyone should wonder.
 *
 * Deliberately generous. Nobody has measured what a normal silence looks
 * like on these machines yet, and a threshold picked without that is a guess
 * dressed as a fact — the same mistake as inventing a price for a model
 * whose rate nobody publishes. A week passes without complaint while the
 * figures accumulate; once the real distribution is visible, this can be set
 * from evidence, per machine, in config.
 */
export const DEFAULT_SILENCE_HOURS = 168

export function recordHeartbeat(db: Database.Database, beat: Heartbeat): void {
  db.prepare(`
    INSERT INTO device_heartbeats (
      device_instance_id, device, last_heartbeat_at, last_records_sent,
      last_parse_ok_at, updated_at
    ) VALUES (@deviceInstanceId, @device, @lastHeartbeatAt, @lastRecordsSent,
              @lastParseOkAt, @updatedAt)
    ON CONFLICT(device_instance_id) DO UPDATE SET
      device            = excluded.device,
      last_heartbeat_at = excluded.last_heartbeat_at,
      last_records_sent = excluded.last_records_sent,
      last_parse_ok_at  = excluded.last_parse_ok_at,
      updated_at        = excluded.updated_at
  `).run({
    deviceInstanceId: beat.deviceInstanceId,
    device: beat.device ?? '',
    lastHeartbeatAt: beat.lastHeartbeatAt,
    lastRecordsSent: beat.lastRecordsSent,
    lastParseOkAt: beat.lastParseOkAt ?? null,
    updatedAt: Date.now(),
  })
}

/**
 * The verdict on every machine that has ever reported in.
 *
 * A machine that has never sent a heartbeat does not appear at all, and that
 * is correct: an older spoke, or one that has never been set up, is unknown
 * rather than broken. Reporting it as silent would invent an outage out of a
 * version difference.
 */
export function hubHealth(
  db: Database.Database,
  options: { silenceHours?: Record<string, number>; now?: () => number } = {},
): SpokeHealth[] {
  const now = (options.now ?? Date.now)()
  const configured = options.silenceHours ?? {}

  const rows = db.prepare(`
    SELECT device_instance_id, device, last_heartbeat_at, last_records_sent, last_parse_ok_at
    FROM device_heartbeats
    ORDER BY device, device_instance_id
  `).all() as Array<{
    device_instance_id: string
    device: string
    last_heartbeat_at: number
    last_records_sent: number
    last_parse_ok_at: number | null
  }>

  return rows.map((row) => {
    const thresholdHours = configured[row.device_instance_id] ?? DEFAULT_SILENCE_HOURS
    const silent = now - row.last_heartbeat_at > thresholdHours * 3600_000
    return {
      deviceInstanceId: row.device_instance_id,
      device: row.device,
      lastHeartbeatAt: row.last_heartbeat_at,
      lastRecordsSent: row.last_records_sent,
      lastParseOkAt: row.last_parse_ok_at,
      thresholdHours,
      silent,
      silentSince: silent ? row.last_heartbeat_at : null,
    }
  })
}
