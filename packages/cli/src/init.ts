import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface State {
  /** Shared secret for the local /api/agent ingest endpoints. */
  ingestToken?: string
  deviceInstanceId: string
  lastSyncAt?: number
  lastSyncStatus: 'ok' | 'failed' | 'conflict_resolved' | 'blocked_pending_consent'
  lastSyncError?: string
  syncConsentAt?: number
  syncConsentTarget?: string
  syncConsents?: Record<string, { syncConsentAt: number; syncConsentTarget: string }>
  lastSyncTarget?: string
  lastSyncUploaded?: number
  lastSyncPulled?: number
  lastSyncDurationMs?: number
  syncTargets?: Record<string, SyncTargetState>
  lastRemoteCleanAt?: number
  lastRemoteCleanSummary?: string
}

export interface SyncTargetState {
  lastSyncAt?: number
  lastSyncStatus?: State['lastSyncStatus']
  lastSyncError?: string
  lastSyncTarget?: string
  lastSyncUploaded?: number
  lastSyncPulled?: number
  lastSyncDurationMs?: number
}

export interface EnsureStateResult {
  created: boolean
  deviceInstanceId: string
  /** Where the id came from, for logging. */
  deviceInstanceIdSource: 'existing_state' | 'existing_records' | 'generated'
  ingestTokenAdded: boolean
}

/**
 * Make sure ~/.aiusage exists and carries a usable state.json.
 *
 * `deriveDeviceInstanceId` is asked for the id already present in the
 * database when there is no state file to read one from. It matters that this
 * is preferred over a fresh UUID — see below.
 */
export function ensureAiusageDir(
  aiusageDir: string,
  deriveDeviceInstanceId?: () => string | null,
): EnsureStateResult {
  if (!existsSync(aiusageDir)) {
    mkdirSync(aiusageDir, { recursive: true, mode: 0o700 })
  }

  const statePath = join(aiusageDir, 'state.json')
  if (!existsSync(statePath)) {
    /*
     * Adopt the device_instance_id the existing records already carry, and
     * only mint a new one when there are none.
     *
     * Minting unconditionally looks harmless and is not:
     *
     *   1. v_agent_sessions joins agent_sessions to records on
     *      (agent_session_id, tool, device_instance_id). A new id on one side
     *      of that join makes usage NULL for every session, permanently.
     *   2. Record ids come from generateRecordId(deviceInstanceId, sourceFile,
     *      lineOffset). Change the id and the same log line hashes to a
     *      different record — a watermark reset or a recalc would then
     *      double-count everything already ingested.
     *
     * This is why an ugly-looking existing value such as 'unknown' is kept
     * rather than replaced with a tidy UUID. Cleaning that up means
     * backfilling records, synced_records and sync_tombstones together, and
     * belongs in its own change.
     */
    const existing = deriveDeviceInstanceId?.() ?? null
    const deviceInstanceId = existing ?? randomUUID()
    const initialState: State = {
      deviceInstanceId,
      // Unrelated to any stored data, so always fresh.
      ingestToken: randomUUID(),
      lastSyncStatus: 'ok',
    }
    writeFileSync(statePath, JSON.stringify(initialState, null, 2), 'utf-8')
    return {
      created: true,
      deviceInstanceId,
      deviceInstanceIdSource: existing ? 'existing_records' : 'generated',
      ingestTokenAdded: true,
    }
  }

  // Existing installs predate the token; mint one rather than leaving the
  // ingest endpoints unauthenticated on an upgrade. deviceInstanceId is never
  // touched here, for the reasons above.
  const state = getState(aiusageDir)
  const ingestTokenAdded = Boolean(state && !state.ingestToken)
  if (ingestTokenAdded) {
    setState(aiusageDir, { ingestToken: randomUUID() })
  }
  return {
    created: false,
    deviceInstanceId: state?.deviceInstanceId ?? '',
    deviceInstanceIdSource: 'existing_state',
    ingestTokenAdded,
  }
}

/**
 * Shared secret for POST /api/agent/*. The env var wins so a user can rotate
 * it or share one across machines without editing state.json.
 *
 * serve binds 0.0.0.0 and the dashboard password is optional, so these
 * endpoints authenticate on their own rather than relying on it.
 */
export function getIngestToken(aiusageDir: string): string | null {
  const fromEnv = process.env.AIUSAGE_INGEST_TOKEN
  if (fromEnv) return fromEnv
  return getState(aiusageDir)?.ingestToken ?? null
}

export function getState(aiusageDir: string): State | null {
  const statePath = join(aiusageDir, 'state.json')
  if (!existsSync(statePath)) return null
  try {
    const content = readFileSync(statePath, 'utf-8')
    return JSON.parse(content)
  } catch {
    return null
  }
}

export function setState(aiusageDir: string, updates: Partial<State>): void {
  const statePath = join(aiusageDir, 'state.json')
  const current = getState(aiusageDir) ?? {
    deviceInstanceId: randomUUID(),
    lastSyncStatus: 'ok' as const,
  }
  const updated = { ...current, ...updates }
  writeFileSync(statePath, JSON.stringify(updated, null, 2), 'utf-8')
}

export function setSyncTargetState(aiusageDir: string, target: string, updates: SyncTargetState): void {
  const statePath = join(aiusageDir, 'state.json')
  const current = getState(aiusageDir) ?? {
    deviceInstanceId: randomUUID(),
    lastSyncStatus: 'ok' as const,
  }
  const targetState = {
    ...(current.syncTargets?.[target] ?? {}),
    ...updates,
    lastSyncTarget: target,
  }
  const legacyUpdates = {
    lastSyncAt: targetState.lastSyncAt,
    lastSyncStatus: targetState.lastSyncStatus ?? current.lastSyncStatus,
    lastSyncError: targetState.lastSyncError,
    lastSyncTarget: target,
    lastSyncUploaded: targetState.lastSyncUploaded,
    lastSyncPulled: targetState.lastSyncPulled,
    lastSyncDurationMs: targetState.lastSyncDurationMs,
  }
  const updated = {
    ...current,
    ...legacyUpdates,
    syncTargets: {
      ...(current.syncTargets ?? {}),
      [target]: targetState,
    },
  }
  writeFileSync(statePath, JSON.stringify(updated, null, 2), 'utf-8')
}

export function setSyncConsent(aiusageDir: string, target: string, consent: { syncConsentAt: number; syncConsentTarget: string }): void {
  const statePath = join(aiusageDir, 'state.json')
  const current = getState(aiusageDir) ?? {
    deviceInstanceId: randomUUID(),
    lastSyncStatus: 'ok' as const,
  }
  const updated = {
    ...current,
    syncConsentAt: consent.syncConsentAt,
    syncConsentTarget: consent.syncConsentTarget,
    syncConsents: {
      ...(current.syncConsents ?? {}),
      [target]: consent,
    },
  }
  writeFileSync(statePath, JSON.stringify(updated, null, 2), 'utf-8')
}
