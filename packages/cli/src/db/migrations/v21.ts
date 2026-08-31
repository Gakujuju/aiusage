import type Database from 'better-sqlite3'

/**
 * Mark rows whose source reported a total but no input/output split.
 *
 * Codex desktop sessions report only a running total; the breakdown fields
 * are all zero and the ratio cannot be recovered. Those turns are recorded
 * with the whole step in input_tokens so the count is right, which makes
 * "input" on those rows really input+output. This column is how anything
 * reading them knows that.
 *
 * On both tables, because a spoke's rows arrive through synced_records and a
 * column that exists in only one of them is a column that gets dropped in
 * transit. That has already happened once here — see the note above the
 * INSERT in mergeSyncedRecordsIntoRecords, where platform went missing for
 * exactly that reason.
 *
 * Deliberately separate from cost_source. That column answers "do we know
 * the price"; this one answers "do we know the shape". A row can be either,
 * both or neither, and folding two axes into one value loses one of them.
 */
export function migrateV21(db: Database.Database): void {
  for (const table of ['records', 'synced_records']) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (!columns.some((c) => c.name === 'breakdown_missing')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN breakdown_missing INTEGER NOT NULL DEFAULT 0`)
    }
  }

  db.prepare('INSERT INTO schema_version (version) VALUES (21)').run()
}
