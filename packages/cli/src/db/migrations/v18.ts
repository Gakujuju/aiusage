import type Database from 'better-sqlite3'

/**
 * Drop the quota rows recorded with an empty device_instance_id.
 *
 * For the period before state.json existed, nothing had minted a device
 * instance id, so quota rows were written with `device_instance_id = ''`.
 * ensureAiusageDir now creates state.json on serve startup, and from that
 * point the same machine records as 'unknown' (D1: the id is left as
 * 'unknown' rather than normalised). The result was that every tier existed
 * twice — one series frozen at the moment state.json appeared, one live —
 * so /api/quotas/history returned two disjoint lines for the same tier, and
 * the '' side's quota_windows rows could never be closed or notified again.
 *
 * The '' period is roughly two hours (2026-08-29 23:04 to 2026-08-30 01:16 on
 * the machine this was found on) and carries no long-term trend value, so it
 * is deleted rather than rewritten. Backfilling would be worse: snapshot ids
 * and window ids are hashes over device_instance_id among other fields, so
 * rewriting the column would leave ids that no longer derive from their own
 * inputs. They are opaque identifiers and nothing would break, but an id that
 * cannot be recomputed is a trap for whoever investigates this table next.
 *
 * recordQuotaSnapshot now refuses to write an empty device_instance_id at all
 * (D17), so this is a one-time cleanup rather than a recurring repair.
 */
export function migrateV18(db: Database.Database): void {
  const tables = ['quota_snapshots', 'quota_current', 'quota_windows'] as const

  // Counted before deleting, so the log records what was actually there. A
  // fresh database runs every migration in order and would otherwise print
  // three "deleted 0 rows" lines on first launch, which says nothing; the
  // whole report is skipped when there is nothing to report.
  const counts: Array<{ table: string; n: number }> = []
  for (const table of tables) {
    // The tables arrived in v13. Checking each one rather than assuming the
    // order keeps this safe against a partial schema.
    const exists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(table)
    if (!exists) continue

    const { n } = db.prepare(
      `SELECT COUNT(*) AS n FROM ${table} WHERE device_instance_id = ''`
    ).get() as { n: number }
    counts.push({ table, n })
  }

  if (counts.some((c) => c.n > 0)) {
    for (const { table, n } of counts) {
      console.log(`[migration v18] ${table}: deleting ${n} row(s) with an empty device_instance_id`)
    }
  }

  for (const { table } of counts) {
    db.prepare(`DELETE FROM ${table} WHERE device_instance_id = ''`).run()
  }

  db.prepare('INSERT INTO schema_version (version) VALUES (18)').run()
}
