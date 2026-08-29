import type Database from 'better-sqlite3'

/**
 * Phase 6-A: subscription quota history.
 *
 * `/api/quotas` used to be a pass-through to the upstream usage APIs — nothing
 * was persisted, so there was no way to draw a trend, compute a burn rate, or
 * show anything at all while the network was down. These three tables are the
 * store behind that:
 *
 *   quota_snapshots — the time series, written only when a value actually moved
 *   quota_current   — one row per (tool, tier, device), the fallback value
 *   quota_windows   — one row per reset window, closed out when the window rolls
 *
 * The view is created here rather than left to `createReadonlyViews`, which
 * only ever runs in v3 and so would never reach an existing database. The same
 * definition is mirrored in schema.ts so a freshly created database matches.
 */
export function migrateV13(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS quota_snapshots (
      id                 TEXT PRIMARY KEY,
      ts                 INTEGER NOT NULL,
      tool               TEXT NOT NULL,
      tier               TEXT NOT NULL,
      utilization        REAL NOT NULL,
      resets_at          INTEGER,
      window_id          TEXT NOT NULL DEFAULT '',
      device             TEXT NOT NULL DEFAULT '',
      device_instance_id TEXT NOT NULL,
      created_at         INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_quota_snap_ts     ON quota_snapshots(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_quota_snap_series ON quota_snapshots(tool, tier, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_quota_snap_window ON quota_snapshots(window_id, ts);
    CREATE INDEX IF NOT EXISTS idx_quota_snap_device ON quota_snapshots(device_instance_id, ts DESC);

    CREATE TABLE IF NOT EXISTS quota_current (
      tool               TEXT NOT NULL,
      tier               TEXT NOT NULL,
      device_instance_id TEXT NOT NULL,
      utilization        REAL NOT NULL DEFAULT 0,
      resets_at          INTEGER,
      window_id          TEXT NOT NULL DEFAULT '',
      ts                 INTEGER NOT NULL,
      cred_status        TEXT NOT NULL DEFAULT 'valid',
      last_success_at    INTEGER,
      last_error         TEXT,
      consecutive_errors INTEGER NOT NULL DEFAULT 0,
      notified_level     INTEGER NOT NULL DEFAULT 0,
      notified_window_id TEXT NOT NULL DEFAULT '',
      updated_at         INTEGER NOT NULL,
      PRIMARY KEY (tool, tier, device_instance_id)
    );

    CREATE TABLE IF NOT EXISTS quota_windows (
      window_id          TEXT PRIMARY KEY,
      tool               TEXT NOT NULL,
      tier               TEXT NOT NULL,
      device_instance_id TEXT NOT NULL,
      started_at         INTEGER NOT NULL,
      resets_at          INTEGER,
      closed_at          INTEGER,
      peak_utilization   REAL NOT NULL DEFAULT 0,
      final_utilization  REAL,
      sample_count       INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_quota_windows_series ON quota_windows(tool, tier, started_at DESC);

    CREATE VIEW IF NOT EXISTS v_quota_snapshots AS
    SELECT
      id, tool, tier, utilization, window_id, device, device_instance_id,
      ts,
      datetime(ts / 1000, 'unixepoch') || 'Z' AS timestamp,
      resets_at,
      CASE WHEN resets_at IS NULL THEN NULL
           ELSE datetime(resets_at / 1000, 'unixepoch') || 'Z' END AS resets_timestamp
    FROM quota_snapshots;

    INSERT INTO schema_version (version) VALUES (13);
  `)
}
