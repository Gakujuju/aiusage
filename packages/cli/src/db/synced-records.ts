import type Database from 'better-sqlite3'
import type { SyncRecord } from '@aiusage/core'

export function insertSyncedRecord(db: Database.Database, record: SyncRecord): boolean {
  // Only replace if the incoming record is newer than what we already have.
  // Without this check, a stale remote record could silently overwrite a newer one.
  const result = db.prepare(`
    INSERT INTO synced_records (
      id, ts, tool, model, provider, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, thinking_tokens,
      cost, cost_source, session_key, device, device_instance_id, platform, updated_at,
      source_file, cwd, breakdown_missing
    ) VALUES (
      @id, @ts, @tool, @model, @provider, @inputTokens, @outputTokens,
      @cacheReadTokens, @cacheWriteTokens, @thinkingTokens,
      @cost, @costSource, @sessionKey, @device, @deviceInstanceId, @platform, @updatedAt,
      @sourceFile, @cwd, @breakdownMissing
    )
    ON CONFLICT(id) DO UPDATE SET
      ts = excluded.ts,
      tool = excluded.tool,
      model = excluded.model,
      provider = excluded.provider,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_write_tokens = excluded.cache_write_tokens,
      thinking_tokens = excluded.thinking_tokens,
      cost = excluded.cost,
      cost_source = excluded.cost_source,
      session_key = excluded.session_key,
      device = excluded.device,
      device_instance_id = excluded.device_instance_id,
      platform = excluded.platform,
      updated_at = excluded.updated_at,
      source_file = excluded.source_file,
      cwd = excluded.cwd,
      breakdown_missing = excluded.breakdown_missing
    WHERE excluded.updated_at > synced_records.updated_at
  `).run({
    id: record.id,
    ts: record.ts,
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
    sessionKey: record.sessionKey,
    device: record.device,
    deviceInstanceId: record.deviceInstanceId,
    platform: record.platform ?? '',
    updatedAt: record.updatedAt,
    sourceFile: record.sourceFile ?? '',
    cwd: record.cwd ?? '',
    breakdownMissing: record.breakdownMissing ? 1 : 0,
  })
  return result.changes > 0
}

export function getSyncedRecordById(db: Database.Database, id: string): SyncRecord | null {
  const row = db.prepare('SELECT * FROM synced_records WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!row) return null
  return mapRowToSyncRecord(row)
}

/**
 * Merge synced_records into records table so API queries can see them.
 * Only inserts records that don't already exist in records.
 * Returns the number of newly inserted records.
 */
export function mergeSyncedRecordsIntoRecords(db: Database.Database): number {
  const now = Date.now()
  const newRows = db.prepare(`
    SELECT sr.* FROM synced_records sr
    LEFT JOIN records r ON sr.id = r.id
    WHERE r.id IS NULL
  `).all() as Record<string, unknown>[]

  // Not an early return any more. Having nothing new to insert says
  // nothing about whether an existing row has been corrected, and
  // returning here skipped every update — which is the whole of D28.
  if (newRows.length === 0) return propagateSyncedUpdates(db)

  /*
   * platform is carried across like every other column.
   *
   * It was being dropped here: synced_records holds it, records has had the
   * column since v4, and the insert simply did not name it — so every record
   * that arrived from another machine landed with an empty platform and the
   * device list showed a blank where the OS should be. Nothing failed, which
   * is why it survived; the value was just quietly gone.
   */
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO records (
      id, ts, ingested_at, synced_at, updated_at, line_offset,
      tool, model, provider, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, thinking_tokens,
      cost, cost_source, session_id, source_file, device, device_instance_id,
      platform, breakdown_missing
    ) VALUES (
      @id, @ts, @ingestedAt, @syncedAt, @updatedAt, 0,
      @tool, @model, @provider, @inputTokens, @outputTokens,
      @cacheReadTokens, @cacheWriteTokens, @thinkingTokens,
      @cost, @costSource, @sessionId, @sourceFile, @device, @deviceInstanceId,
      @platform, @breakdownMissing
    )
  `)

  const tx = db.transaction((rows: Record<string, unknown>[]) => {
    for (const row of rows) {
      const sourceFile = (typeof row.source_file === 'string' && row.source_file)
        ? row.source_file
        : `synced/${row.device_instance_id}`
      insertStmt.run({
        id: row.id,
        ts: row.ts,
        ingestedAt: now,
        syncedAt: now,
        updatedAt: row.updated_at,
        tool: row.tool,
        model: row.model,
        provider: row.provider,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        thinkingTokens: row.thinking_tokens,
        cost: row.cost,
        costSource: row.cost_source,
        sessionId: row.session_key,
        sourceFile,
        device: row.device,
        deviceInstanceId: row.device_instance_id,
        platform: (typeof row.platform === 'string' ? row.platform : '') || '',
        breakdownMissing: row.breakdown_missing ? 1 : 0,
        cwd: (typeof row.cwd === 'string' ? row.cwd : '') || '',
      })
    }
  })

  tx(newRows)
  return newRows.length + propagateSyncedUpdates(db)
}

/**
 * Carry a spoke's corrections through to records (D28).
 *
 * The merge only ever inserted — WHERE r.id IS NULL — so once a row had
 * arrived, nothing about it could change again. Every correction made on a
 * spoke stopped at synced_records: the platform backfill, recalculated
 * costs, the codex token fix. The hub kept showing the first version of a
 * row for ever, and the two tables drifted apart with no way to notice.
 *
 * updated_at decides. A row is replaced only when the copy that arrived is
 * newer than the one already stored, so a late-arriving stale upload cannot
 * undo a correction made here.
 *
 * Rows the hub produced itself are never touched. They cannot appear in
 * synced_records today — a spoke has no reason to send back what the hub
 * made — but "cannot happen today" is how the source_file assumption
 * started, and this one costs a WHERE clause.
 *
 * ingested_at is deliberately left alone: it records when this machine
 * first saw the row, which a later correction does not change.
 */
function propagateSyncedUpdates(db: Database.Database): number {
  const result = db.prepare(`
    UPDATE records
       SET ts = (SELECT s.ts FROM synced_records s WHERE s.id = records.id),
           updated_at = (SELECT s.updated_at FROM synced_records s WHERE s.id = records.id),
           tool = (SELECT s.tool FROM synced_records s WHERE s.id = records.id),
           model = (SELECT s.model FROM synced_records s WHERE s.id = records.id),
           provider = (SELECT s.provider FROM synced_records s WHERE s.id = records.id),
           input_tokens = (SELECT s.input_tokens FROM synced_records s WHERE s.id = records.id),
           output_tokens = (SELECT s.output_tokens FROM synced_records s WHERE s.id = records.id),
           cache_read_tokens = (SELECT s.cache_read_tokens FROM synced_records s WHERE s.id = records.id),
           cache_write_tokens = (SELECT s.cache_write_tokens FROM synced_records s WHERE s.id = records.id),
           thinking_tokens = (SELECT s.thinking_tokens FROM synced_records s WHERE s.id = records.id),
           cost = (SELECT s.cost FROM synced_records s WHERE s.id = records.id),
           cost_source = (SELECT s.cost_source FROM synced_records s WHERE s.id = records.id),
           platform = (SELECT COALESCE(s.platform, '') FROM synced_records s WHERE s.id = records.id),
           breakdown_missing = (SELECT s.breakdown_missing FROM synced_records s WHERE s.id = records.id)
     WHERE EXISTS (
             SELECT 1 FROM synced_records s
              WHERE s.id = records.id
                AND s.updated_at > records.updated_at
                AND s.device_instance_id = records.device_instance_id
           )
  `).run()
  return result.changes
}

function mapRowToSyncRecord(row: Record<string, unknown>): SyncRecord {
  return {
    id: row.id as string,
    ts: row.ts as number,
    tool: row.tool as SyncRecord['tool'],
    model: row.model as string,
    provider: row.provider as string,
    inputTokens: row.input_tokens as number,
    outputTokens: row.output_tokens as number,
    cacheReadTokens: row.cache_read_tokens as number,
    cacheWriteTokens: row.cache_write_tokens as number,
    thinkingTokens: row.thinking_tokens as number,
    cost: row.cost as number,
    costSource: row.cost_source as SyncRecord['costSource'],
    sessionKey: row.session_key as string,
    device: row.device as string,
    deviceInstanceId: row.device_instance_id as string,
    platform: row.platform as string | undefined,
    updatedAt: row.updated_at as number,
    sourceFile: (row.source_file as string) || undefined,
    cwd: (row.cwd as string) || undefined,
  }
}
