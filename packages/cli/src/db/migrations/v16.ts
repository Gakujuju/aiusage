import type Database from 'better-sqlite3'

/**
 * Repair the v_agent_sessions usage join.
 *
 * v14 joined agent_sessions to records on session_id = agent_session_id,
 * assuming records.session_id holds the bare session UUID. On Windows it does
 * not: extractSessionId (parse.ts) splits the path on '/' only, so a
 * backslash path never splits and session_id ends up as the whole path minus
 * the .jsonl extension —
 *
 *   C:\Users\...\projects\C--Users-...-aiusage\02266b28-....jsonl
 *     → session_id "C:\Users\...\projects\C--Users-...-aiusage\02266b28-..."
 *
 * The join therefore matched nothing and every session reported NULL usage.
 * Confirmed against a real database: four sessions, all NULL, 597 matching
 * records sitting right there.
 *
 * The condition now also accepts a session_id that *ends with* the id, which
 * covers both shapes. That keeps working if the upstream extraction is
 * corrected later — the equality arm takes over — so this needs no follow-up.
 *
 * CREATE VIEW IF NOT EXISTS cannot redefine an existing view, hence the drop.
 */
export function migrateV16(db: Database.Database): void {
  db.exec(`
    DROP VIEW IF EXISTS v_agent_sessions;

    CREATE VIEW v_agent_sessions AS
    SELECT s.*, u.record_count, u.total_cost, u.total_tokens, u.first_ts, u.last_ts
    FROM agent_sessions s
    LEFT JOIN (
      SELECT session_id, tool, device_instance_id,
             COUNT(*) AS record_count,
             SUM(cost) AS total_cost,
             SUM(input_tokens + output_tokens + cache_read_tokens
                 + cache_write_tokens + thinking_tokens) AS total_tokens,
             MIN(ts) AS first_ts, MAX(ts) AS last_ts
      FROM records
      WHERE source_file NOT LIKE 'synced/%'
      GROUP BY session_id, tool, device_instance_id
    ) u ON u.tool = s.tool
       AND u.device_instance_id = s.device_instance_id
       AND (u.session_id = s.agent_session_id
            OR u.session_id LIKE '%' || s.agent_session_id);

    INSERT INTO schema_version (version) VALUES (16);
  `)
}
