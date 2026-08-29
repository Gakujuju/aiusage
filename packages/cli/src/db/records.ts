import type Database from 'better-sqlite3'
import type { StatsRecord } from '@aiusage/core'

export function insertRecord(db: Database.Database, record: StatsRecord): void {
  db.prepare(`
    INSERT OR REPLACE INTO records (
      id, ts, ingested_at, synced_at, updated_at, line_offset,
      tool, model, provider, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, thinking_tokens,
      cost, cost_source, session_id, source_file, cwd, device, device_instance_id, platform
    ) VALUES (
      @id, @ts, @ingestedAt, @syncedAt, @updatedAt, @lineOffset,
      @tool, @model, @provider, @inputTokens, @outputTokens,
      @cacheReadTokens, @cacheWriteTokens, @thinkingTokens,
      @cost, @costSource, @sessionId, @sourceFile, @cwd, @device, @deviceInstanceId, @platform
    )
  `).run({
    id: record.id,
    ts: record.ts,
    ingestedAt: record.ingestedAt,
    syncedAt: record.syncedAt ?? null,
    updatedAt: record.updatedAt,
    lineOffset: record.lineOffset,
    tool: record.tool,
    model: record.model,
    provider: record.provider,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cacheReadTokens: record.cacheReadTokens,
    cacheWriteTokens: record.cacheWriteTokens,
    thinkingTokens: record.thinkingTokens,
    cost: record.cost,
    costSource: record.costSource,
    sessionId: record.sessionId,
    sourceFile: record.sourceFile,
    cwd: record.cwd ?? '',
    device: record.device,
    deviceInstanceId: record.deviceInstanceId,
    platform: record.platform ?? '',
  })
}

export function getRecordById(db: Database.Database, id: string): StatsRecord | null {
  const row = db.prepare('SELECT * FROM records WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!row) return null
  return mapRowToRecord(row)
}

export function getRecordsBySourceFile(db: Database.Database, sourceFile: string): StatsRecord[] {
  const rows = db.prepare('SELECT * FROM records WHERE source_file = ?').all(sourceFile) as Record<string, unknown>[]
  return rows.map(mapRowToRecord)
}

export function deleteRecordsBySourceFile(db: Database.Database, sourceFile: string): number {
  const result = db.prepare('DELETE FROM records WHERE source_file = ?').run(sourceFile)
  return result.changes
}

export function getUnsyncedRecords(db: Database.Database, target?: string): StatsRecord[] {
  const rows = target
    ? db.prepare(`
        SELECT r.* FROM records r
        LEFT JOIN sync_record_state s
          ON s.record_id = r.id AND s.target = ?
        WHERE r.source_file NOT LIKE 'synced/%'
          AND (s.synced_at IS NULL OR r.updated_at > s.synced_at)
      `).all(target) as Record<string, unknown>[]
    : db.prepare(
      'SELECT * FROM records WHERE synced_at IS NULL OR updated_at > synced_at'
    ).all() as Record<string, unknown>[]
  return rows.map(mapRowToRecord)
}

export function markRecordsSynced(db: Database.Database, ids: string[], syncedAt: number, target?: string): void {
  if (ids.length === 0) return

  if (target) {
    const insertStmt = db.prepare(`
      INSERT INTO sync_record_state (record_id, target, synced_at)
      VALUES (?, ?, ?)
      ON CONFLICT(record_id, target) DO UPDATE SET synced_at = excluded.synced_at
    `)
    const legacyStmt = db.prepare('UPDATE records SET synced_at = ? WHERE id = ?')
    const tx = db.transaction((recordIds: string[]) => {
      for (const id of recordIds) {
        insertStmt.run(id, target, syncedAt)
        legacyStmt.run(syncedAt, id)
      }
    })
    tx(ids)
    return
  }

  const updateStmt = db.prepare('UPDATE records SET synced_at = ? WHERE id = ?')
  const tx = db.transaction((recordIds: string[]) => {
    for (const id of recordIds) updateStmt.run(syncedAt, id)
  })
  tx(ids)
}

function mapRowToRecord(row: Record<string, unknown>): StatsRecord {
  return {
    id: row.id as string,
    ts: row.ts as number,
    ingestedAt: row.ingested_at as number,
    syncedAt: row.synced_at != null ? (row.synced_at as number) : undefined,
    updatedAt: row.updated_at as number,
    lineOffset: row.line_offset as number,
    tool: row.tool as StatsRecord['tool'],
    model: row.model as string,
    provider: row.provider as string,
    inputTokens: row.input_tokens as number,
    outputTokens: row.output_tokens as number,
    cacheReadTokens: row.cache_read_tokens as number,
    cacheWriteTokens: row.cache_write_tokens as number,
    thinkingTokens: row.thinking_tokens as number,
    cost: row.cost as number,
    costSource: row.cost_source as StatsRecord['costSource'],
    sessionId: row.session_id as string,
    sourceFile: row.source_file as string,
    cwd: (row.cwd as string) || undefined,
    device: row.device as string,
    deviceInstanceId: row.device_instance_id as string,
    platform: (row.platform as string) || undefined,
  }
}

/**
 * The device_instance_id the stored records already use, or null when there
 * are none.
 *
 * Used when state.json is missing, to adopt the id the data was written with
 * rather than inventing a new one — see ensureAiusageDir for why that
 * distinction matters. Ties are broken by row count, so a database that has
 * somehow accumulated two ids follows the majority.
 */
export function findPredominantDeviceInstanceId(db: Database.Database): string | null {
  const row = db.prepare(`
    SELECT device_instance_id AS id, COUNT(*) AS n
    FROM records
    GROUP BY device_instance_id
    ORDER BY n DESC
    LIMIT 1
  `).get() as { id: string; n: number } | undefined
  return row?.id ?? null
}

export interface UnpricedSummary {
  /** Records whose cost could not be computed from a price table. */
  unpricedRecords: number
  /** The models responsible, most affected first. */
  unpricedModels: string[]
}

/**
 * How much usage is going uncosted, and which models are to blame.
 *
 * Both halves of the condition matter. cost_source='unknown' is the honest
 * signal, but records written before that was set correctly report 'pricing'
 * with a cost of zero — so a row with tokens and no cost counts too.
 */
export function countUnpricedRecords(db: Database.Database): UnpricedSummary {
  const rows = db.prepare(`
    SELECT model, COUNT(*) AS n
    FROM records
    WHERE cost_source = 'unknown'
       OR (cost = 0 AND (input_tokens + output_tokens + cache_read_tokens
                         + cache_write_tokens + thinking_tokens) > 0)
    GROUP BY model
    ORDER BY n DESC
  `).all() as Array<{ model: string; n: number }>

  return {
    unpricedRecords: rows.reduce((acc, r) => acc + r.n, 0),
    unpricedModels: rows.map((r) => r.model),
  }
}
