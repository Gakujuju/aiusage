import type Database from 'better-sqlite3'

/**
 * Every format carries breakdownMissing.
 *
 * Without it a reader sees tokens, a cost of zero and cost_source 'unknown',
 * and cannot tell whether the price is missing or the log never gave a token
 * split. Those are different facts: the first is fixable, the second is not,
 * and only the second means the input column is really a lump total.
 *
 * Confusing the two put a warning on the home screen naming a model that
 * already had a price. Dropping the flag here would hand the same confusion
 * to whatever reads the export, with no way at all to resolve it.
 */
export function exportData(db: Database.Database, format: 'csv' | 'json' | 'ndjson'): string {
  const records = db.prepare('SELECT * FROM records').all() as any[]

  if (format === 'csv') {
    const headers = 'timestamp,tool,model,provider,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,thinking_tokens,cost,cost_source,breakdown_missing,session_id,device,device_instance_id'
    const rows = records.map(r => {
      const ts = new Date(r.ts).toISOString()
      return `${ts},${r.tool},${r.model},${r.provider},${r.input_tokens},${r.output_tokens},${r.cache_read_tokens},${r.cache_write_tokens},${r.thinking_tokens},${r.cost},${r.cost_source},${r.breakdown_missing},${r.session_id},${r.device},${r.device_instance_id}`
    })
    return [headers, ...rows].join('\n')
  }

  if (format === 'json') {
    const data = records.map(r => ({
      timestamp: new Date(r.ts).toISOString(),
      tool: r.tool,
      model: r.model,
      provider: r.provider,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens,
      cacheWriteTokens: r.cache_write_tokens,
      thinkingTokens: r.thinking_tokens,
      cost: r.cost,
      costSource: r.cost_source,
      breakdownMissing: r.breakdown_missing === 1,
      sessionId: r.session_id,
      device: r.device,
      deviceInstanceId: r.device_instance_id,
    }))
    return JSON.stringify(data, null, 2)
  }

  // ndjson
  const lines = records.map(r => JSON.stringify({
    id: r.id,
    ts: r.ts,
    tool: r.tool,
    model: r.model,
    provider: r.provider,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    thinkingTokens: r.thinking_tokens,
    cost: r.cost,
    costSource: r.cost_source,
    breakdownMissing: r.breakdown_missing === 1,
    sessionKey: r.session_id,
    device: r.device,
    deviceInstanceId: r.device_instance_id,
    updatedAt: r.updated_at,
  }))
  return lines.join('\n')
}
