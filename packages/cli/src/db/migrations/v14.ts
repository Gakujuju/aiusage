import type Database from 'better-sqlite3'

/**
 * Phase 6-B: agent session state.
 *
 * `records` says what an agent spent; nothing said what it was *doing*. These
 * three tables are that:
 *
 *   agent_sessions        one row per session, mutated in place — the current state
 *   agent_session_events  append-only log of everything we were told
 *   agent_session_spans   one row per stretch spent in a status — the time accounting
 *
 * agent_sessions carries no foreign key to `records`: hook events always arrive
 * before the JSONL that produced them is parsed, so a key would make
 * session_start fail every time. The join is
 * (agent_session_id, tool, device_instance_id) ←→ records(session_id, tool,
 * device_instance_id), done in the view. The events and spans tables do carry
 * keys, because their parent is always written first in the same transaction.
 *
 * These tables are local-only and deliberately outside the sync path.
 */
export function migrateV14(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id                  TEXT PRIMARY KEY,
      agent_session_id    TEXT NOT NULL,
      tool                TEXT NOT NULL,
      device              TEXT NOT NULL DEFAULT '',
      device_instance_id  TEXT NOT NULL,
      platform            TEXT NOT NULL DEFAULT '',
      cwd                 TEXT NOT NULL DEFAULT '',
      project             TEXT NOT NULL DEFAULT '',
      pid                 INTEGER,

      status              TEXT NOT NULL DEFAULT 'unknown',
      status_detail       TEXT NOT NULL DEFAULT '',
      status_source       TEXT NOT NULL DEFAULT 'unknown',
      status_confidence   REAL NOT NULL DEFAULT 0,
      status_since        INTEGER NOT NULL,
      status_expires_at   INTEGER,

      last_event_at       INTEGER NOT NULL,
      last_event_kind     TEXT NOT NULL DEFAULT '',
      last_heartbeat_at   INTEGER,

      started_at          INTEGER NOT NULL,
      ended_at            INTEGER,
      exit_reason         TEXT,

      last_prompt_at      INTEGER,
      last_prompt_preview TEXT NOT NULL DEFAULT '',
      turn_count          INTEGER NOT NULL DEFAULT 0,

      notify_state        TEXT NOT NULL DEFAULT '',
      notified_at         INTEGER,

      record_link_state   TEXT NOT NULL DEFAULT 'pending',
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      UNIQUE (device_instance_id, tool, agent_session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_sessions_status     ON agent_sessions(status, last_event_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_device     ON agent_sessions(device_instance_id, status);
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_tool       ON agent_sessions(tool);
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_last_event ON agent_sessions(last_event_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_link       ON agent_sessions(agent_session_id, tool, device_instance_id);
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_open       ON agent_sessions(status_expires_at) WHERE ended_at IS NULL;

    CREATE TABLE IF NOT EXISTS agent_session_events (
      id             TEXT PRIMARY KEY,
      session_pk     TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      ts             INTEGER NOT NULL,
      received_at    INTEGER NOT NULL,
      kind           TEXT NOT NULL,
      source         TEXT NOT NULL,
      status_before  TEXT,
      status_after   TEXT,
      confidence     REAL NOT NULL DEFAULT 0,
      payload        TEXT NOT NULL DEFAULT '{}',
      dedupe_key     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_agent_events_session ON agent_session_events(session_pk, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_events_ts      ON agent_session_events(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_events_kind    ON agent_session_events(kind, ts DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_events_dedupe
      ON agent_session_events(dedupe_key) WHERE dedupe_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS agent_session_spans (
      id          TEXT PRIMARY KEY,
      session_pk  TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      status      TEXT NOT NULL,
      source      TEXT NOT NULL DEFAULT '',
      confidence  REAL NOT NULL DEFAULT 0,
      started_at  INTEGER NOT NULL,
      ended_at    INTEGER,
      duration_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_agent_spans_session ON agent_session_spans(session_pk, started_at);
    CREATE INDEX IF NOT EXISTS idx_agent_spans_status  ON agent_session_spans(status, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_spans_open    ON agent_session_spans(session_pk) WHERE ended_at IS NULL;

    CREATE VIEW IF NOT EXISTS v_agent_sessions AS
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
    ) u ON u.session_id = s.agent_session_id
       AND u.tool = s.tool
       AND u.device_instance_id = s.device_instance_id;

    INSERT INTO schema_version (version) VALUES (14);
  `)
}
