import type Database from 'better-sqlite3'

/**
 * Backfill records.session_id from a full path to a bare session id.
 *
 * extractSessionId split paths on '/' only, so on Windows nothing split and
 * session_id kept the whole path minus the extension:
 *
 *   C:\Users\...\projects\C--Users-...-aiusage\02266b28-....jsonl
 *     → "C:\Users\...\projects\C--Users-...-aiusage\02266b28-..."
 *
 * The parser is fixed; this repairs what it already wrote.
 *
 * record ids do not derive from session_id, so no row identity changes and
 * nothing can be double-counted. v_agent_sessions keeps its tolerant join
 * (DECISIONS.md D6) — after this the equality arm matches, and the LIKE arm
 * remains for rows that may later sync in from an unfixed device.
 */

/**
 * The last path segment, minus a trailing `.jsonl`.
 *
 * Exported for the tests: the interesting cases are the ones that must be
 * left alone, and they are easier to state as a function than as SQL.
 */
export function sessionIdFromPathLike(value: string): string | null {
  // No separator: either already a bare id, or a tool that derives the id from
  // something other than a filename (qoder uses the directory above
  // `segments`). Rewriting those would break them.
  if (!/[\\/]/.test(value)) return null

  const normalised = value.replace(/\\/g, '/')
  const last = normalised.slice(normalised.lastIndexOf('/') + 1)
  // A trailing separator would leave nothing behind. Leave the row untouched
  // rather than blanking its session id.
  if (!last) return null

  const withoutExtension = last.replace(/\.jsonl$/i, '')
  return withoutExtension || null
}

export function migrateV17(db: Database.Database): void {
  // instr rather than LIKE: matching a literal backslash with LIKE ... ESCAPE
  // needs a doubled escape, and getting it subtly wrong matches percent signs
  // instead — which is exactly what happened while writing this.
  const rows = db.prepare(`
    SELECT id, tool, session_id FROM records
    WHERE instr(session_id, '/') > 0 OR instr(session_id, char(92)) > 0
  `).all() as Array<{ id: string; tool: string; session_id: string }>

  if (rows.length === 0) {
    db.prepare('INSERT INTO schema_version (version) VALUES (17)').run()
    return
  }

  const before: Record<string, number> = {}
  for (const row of rows) before[row.tool] = (before[row.tool] ?? 0) + 1
  console.log(
    '[migration v17] path-shaped session ids before: ' +
    Object.entries(before).map(([tool, n]) => `${tool}=${n}`).join(' ')
  )

  const update = db.prepare('UPDATE records SET session_id = ?, updated_at = ? WHERE id = ?')
  const now = Date.now()
  const rewritten: Record<string, number> = {}
  let skipped = 0

  for (const row of rows) {
    const next = sessionIdFromPathLike(row.session_id)
    if (next == null || next === row.session_id) {
      skipped++
      continue
    }
    update.run(next, now, row.id)
    rewritten[row.tool] = (rewritten[row.tool] ?? 0) + 1
  }

  console.log(
    '[migration v17] rewrote: ' +
    (Object.entries(rewritten).map(([tool, n]) => `${tool}=${n}`).join(' ') || 'none') +
    (skipped > 0 ? ` (left ${skipped} untouched)` : '')
  )

  db.prepare('INSERT INTO schema_version (version) VALUES (17)').run()
}
