import { openSync, readSync, closeSync, statSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type Database from 'better-sqlite3'
import type { AgentEventInput } from '../db/agent-sessions.js'
import { extractSessionId } from '../commands/parse.js'

/**
 * Follow Codex rollout logs and turn their lifecycle lines into agent events.
 *
 * Codex has nothing resembling Claude Code's hooks: `notify` takes a single
 * program (already claimed by another integration on the machine this was
 * written for), and hooks.json covers only Pre/PostToolUse for shell tools.
 * The rollout log is the only place the session lifecycle is written down —
 * and aiusage already parses these files for usage, so nothing new is read.
 * See DECISIONS.md D18.
 */

export const CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions')

/** How far back a file's mtime can be and still count as live. */
export const ACTIVE_WINDOW_MS = 30 * 60 * 1000

/**
 * How many days of session directories to look in.
 *
 * Directories are named for the day a session *started*, not the day it was
 * last written to: a session opened on the 27th and still being appended to
 * on the 30th lives under 08/27. Scanning "today and yesterday" would miss
 * exactly the long-running sessions this watcher is most useful for, so the
 * window is wider than the mtime filter needs, and directories holding a file
 * we already have a cursor for are always included regardless of their name.
 */
export const SCAN_DAYS = 7

/** Bytes to read per file per tick. A tail should never be a full read. */
const MAX_READ_BYTES = 1 << 20

/**
 * Payload keys that are safe to keep, by Codex event type.
 *
 * A whitelist rather than a blacklist, and a strict one: rollout logs contain
 * the entire conversation. `message`, `last_agent_message`, `text_elements`,
 * `content` and `base_instructions` are all prose and must never be stored.
 * `git` is repository metadata that says nothing about the session's state.
 */
const PAYLOAD_WHITELIST: Record<string, readonly string[]> = {
  session_meta: ['originator', 'cli_version', 'source', 'model_provider', 'history_mode'],
  task_started: ['turn_id', 'started_at', 'model_context_window', 'collaboration_mode_kind'],
  task_complete: ['turn_id', 'started_at', 'completed_at'],
  user_message: [],
}

/** Keys consumed into columns rather than dropped, so they are not reported. */
const CONSUMED_KEYS = new Set(['type', 'cwd', 'session_id', 'id', 'timestamp'])

export interface CodexLogLine {
  /** 'session_meta', or 'event_msg/<payload.type>' collapsed to the inner type. */
  eventType: string
  ts: number
  payload: Record<string, unknown>
}

export interface CursorRow {
  source_file: string
  tool: string
  byte_offset: number
  last_size: number
  updated_at: number
}

/**
 * Which lines matter, and what they mean.
 *
 * Everything else — response_item, agent_message, token_count — is either
 * conversation content or accounting we already get from the parser.
 */
export function eventForLine(line: CodexLogLine, sessionId: string): AgentEventInput | null {
  const base = {
    sessionId,
    tool: 'codex',
    ts: line.ts,
    source: 'log' as const,
    payload: sanitizePayload(line.eventType, line.payload),
    detail: line.eventType,
  }

  switch (line.eventType) {
    case 'session_meta':
      return { ...base, kind: 'session_start', cwd: readCwd(line.payload) }
    case 'user_message':
      // The only line that begins a turn as far as the counter is concerned.
      return { ...base, kind: 'user_prompt', countsAsTurn: true }
    case 'task_started':
      // Same status, same turn. Recorded because it is the earliest sign the
      // agent is working, but it must not advance turn_count — Codex emits it
      // alongside user_message on every turn.
      return { ...base, kind: 'user_prompt', countsAsTurn: false }
    case 'task_complete':
      return { ...base, kind: 'stop' }
    default:
      return null
  }
}

function readCwd(payload: Record<string, unknown>): string | undefined {
  const cwd = payload.cwd
  return typeof cwd === 'string' && cwd ? cwd : undefined
}

/**
 * Keep the whitelisted keys, record the names of the rest.
 *
 * The dropped *names* are safe — they are field names from a schema, not
 * user text — and knowing what was thrown away is what makes it possible to
 * notice when Codex adds a field worth keeping.
 */
export function sanitizePayload(
  eventType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = PAYLOAD_WHITELIST[eventType] ?? []
  const kept: Record<string, unknown> = { event_type: eventType }
  const dropped: string[] = []

  for (const [key, value] of Object.entries(payload)) {
    if (allowed.includes(key)) {
      // Only scalars. A whitelisted key that turns into an object one day
      // would otherwise smuggle whatever the object contains.
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
        kept[key] = value
        continue
      }
      dropped.push(key)
      continue
    }
    if (CONSUMED_KEYS.has(key)) continue
    dropped.push(key)
  }

  if (dropped.length > 0) kept._droppedKeys = dropped
  return kept
}

/** One JSONL line, reduced to the three things that matter. */
export function parseLine(raw: string): CodexLogLine | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  let obj: unknown
  try {
    obj = JSON.parse(trimmed)
  } catch {
    // A partial write at the end of the file. The cursor is not advanced past
    // it, so the next tick reads the completed line.
    return null
  }
  if (!obj || typeof obj !== 'object') return null

  const record = obj as Record<string, unknown>
  const payload = (record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload))
    ? record.payload as Record<string, unknown>
    : {}

  const outerType = typeof record.type === 'string' ? record.type : ''
  const innerType = typeof payload.type === 'string' ? payload.type : ''
  const eventType = outerType === 'event_msg' ? innerType : outerType
  if (!eventType) return null

  const ts = Date.parse(typeof record.timestamp === 'string' ? record.timestamp : '')
  return {
    eventType,
    ts: Number.isFinite(ts) ? ts : Date.now(),
    payload,
  }
}

export interface ScanOptions {
  now: number
  sessionsDir?: string
  scanDays?: number
  activeWindowMs?: number
  /** Files already being followed, included whatever their directory is named. */
  knownFiles?: readonly string[]
}

/**
 * Rollout files worth reading this tick.
 *
 * Two filters, for two different costs. The directory filter bounds how much
 * of the tree is walked at all — this grows by one directory per day of use
 * forever. The mtime filter bounds how many files are opened, and is the one
 * that actually decides what gets read.
 */
export function scanActiveFiles(options: ScanOptions): string[] {
  const dir = options.sessionsDir ?? CODEX_SESSIONS_DIR
  const scanDays = options.scanDays ?? SCAN_DAYS
  const activeWindow = options.activeWindowMs ?? ACTIVE_WINDOW_MS
  if (!existsSync(dir)) return []

  const candidates = new Set<string>(options.knownFiles ?? [])

  for (const dayDir of recentDayDirs(dir, options.now, scanDays)) {
    let entries: string[]
    try {
      entries = readdirSync(dayDir)
    } catch {
      continue
    }
    for (const name of entries) {
      if (name.startsWith('rollout-') && name.endsWith('.jsonl')) {
        candidates.add(join(dayDir, name))
      }
    }
  }

  const active: string[] = []
  for (const file of candidates) {
    let stat
    try {
      stat = statSync(file)
    } catch {
      // Deleted between the listing and here, or a cursor for a file that is
      // gone. Nothing to read either way.
      continue
    }
    if (options.now - stat.mtimeMs <= activeWindow) active.push(file)
  }
  return active.sort()
}

/**
 * `<dir>/YYYY/MM/DD` paths for the last `days` days.
 *
 * Built from the dates rather than by walking the tree, so the cost does not
 * grow with how long the tool has been in use.
 */
function recentDayDirs(root: string, now: number, days: number): string[] {
  const dirs: string[] = []
  for (let i = 0; i < days; i++) {
    const d = new Date(now - i * 24 * 60 * 60 * 1000)
    dirs.push(join(
      root,
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    ))
  }
  return dirs
}

export interface ReadResult {
  events: AgentEventInput[]
  /** Where to resume next tick. */
  offset: number
  size: number
  /** True when the file shrank and the tail was skipped rather than replayed. */
  truncated: boolean
  /** True the first time this file is seen; no events are produced. */
  firstSight: boolean
  sessionId: string
}

/**
 * Read whatever was appended since the cursor.
 *
 * A file seen for the first time starts at its current end. Reading it from
 * the beginning would turn a 44 MB backlog into thousands of "work finished"
 * notifications on the first serve start after an upgrade — the same accident
 * as announcing a quota threshold on the first observation, and prevented the
 * same way: no baseline, no event.
 */
export function readNewEvents(
  file: string,
  cursor: CursorRow | undefined,
  now: number,
): ReadResult {
  const sessionId = extractSessionId(file, 'codex')
  let size: number
  try {
    size = statSync(file).size
  } catch {
    return { events: [], offset: cursor?.byte_offset ?? 0, size: 0, truncated: false, firstSight: false, sessionId }
  }

  if (!cursor) {
    return { events: [], offset: size, size, truncated: false, firstSight: true, sessionId }
  }

  if (size < cursor.last_size) {
    // Truncated or replaced. The stored offset points into a file that no
    // longer exists in that shape; resuming at 0 would replay what is left.
    return { events: [], offset: size, size, truncated: true, firstSight: false, sessionId }
  }

  if (size <= cursor.byte_offset) {
    return { events: [], offset: cursor.byte_offset, size, truncated: false, firstSight: false, sessionId }
  }

  const start = cursor.byte_offset
  const wanted = Math.min(size - start, MAX_READ_BYTES)
  const buffer = Buffer.allocUnsafe(wanted)
  let read = 0
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    read = readSync(fd, buffer, 0, wanted, start)
  } catch {
    return { events: [], offset: start, size, truncated: false, firstSight: false, sessionId }
  } finally {
    if (fd != null) closeSync(fd)
  }

  const chunk = buffer.subarray(0, read).toString('utf-8')
  // Stop at the last newline: anything after it is a line still being
  // written. Leaving it behind means the offset resumes at its start.
  const lastNewline = chunk.lastIndexOf('\n')
  if (lastNewline === -1) {
    return { events: [], offset: start, size, truncated: false, firstSight: false, sessionId }
  }

  const complete = chunk.slice(0, lastNewline)
  const consumed = Buffer.byteLength(complete, 'utf-8') + 1

  const events: AgentEventInput[] = []
  for (const raw of complete.split('\n')) {
    const line = parseLine(raw)
    if (!line) continue
    const event = eventForLine(line, sessionId)
    if (event) events.push(event)
  }

  return { events, offset: start + consumed, size, truncated: false, firstSight: false, sessionId }
}

export function loadCursors(db: Database.Database, tool: string): Map<string, CursorRow> {
  const rows = db.prepare(
    'SELECT * FROM agent_log_cursors WHERE tool = ?'
  ).all(tool) as CursorRow[]
  return new Map(rows.map((row) => [row.source_file, row]))
}

export function saveCursor(
  db: Database.Database,
  file: string,
  tool: string,
  offset: number,
  size: number,
  now: number,
): void {
  db.prepare(`
    INSERT INTO agent_log_cursors (source_file, tool, byte_offset, last_size, updated_at)
    VALUES (@file, @tool, @offset, @size, @now)
    ON CONFLICT(source_file) DO UPDATE SET
      byte_offset = @offset, last_size = @size, updated_at = @now
  `).run({ file, tool, offset, size, now })
}

/**
 * Cursors recent enough that their file might still be appended to.
 *
 * Feeds scanActiveFiles so a session that started days ago is still followed
 * even though its directory is named for a date outside the scan window.
 */
export function recentCursorFiles(db: Database.Database, tool: string, now: number): string[] {
  const cutoff = now - 2 * 24 * 60 * 60 * 1000
  const rows = db.prepare(
    'SELECT source_file FROM agent_log_cursors WHERE tool = ? AND updated_at >= ?'
  ).all(tool, cutoff) as Array<{ source_file: string }>
  return rows.map((r) => r.source_file)
}

/**
 * The first line of a rollout file, if it is a session_meta.
 *
 * The one deliberate look backwards. A file seen for the first time is read
 * from its end, which means the session would otherwise have no row at all
 * until its next turn — and no cwd, so no project name, ever. Reading the
 * header gives the session an identity without letting the backlog claim a
 * status: the event this produces carries none.
 */
export function readSessionHeader(file: string): CodexLogLine | null {
  const HEADER_BYTES = 64 * 1024
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const buffer = Buffer.allocUnsafe(HEADER_BYTES)
    const read = readSync(fd, buffer, 0, HEADER_BYTES, 0)
    const text = buffer.subarray(0, read).toString('utf-8')
    const end = text.indexOf('\n')
    const line = parseLine(end === -1 ? text : text.slice(0, end))
    return line?.eventType === 'session_meta' ? line : null
  } catch {
    return null
  } finally {
    if (fd != null) closeSync(fd)
  }
}

export interface TickResult {
  filesScanned: number
  filesRead: number
  eventsApplied: number
  firstSeen: number
  truncated: number
}

export type ApplyEvents = (events: AgentEventInput[]) => number

export interface TickOptions {
  db: Database.Database
  applyEvents: ApplyEvents
  now: number
  sessionsDir?: string
  scanDays?: number
  activeWindowMs?: number
  onWarn?: (message: string) => void
}

/**
 * One pass: find the live files, read what is new, apply it, save the cursors.
 *
 * Everything the caller needs to serialise (the DB writes) happens through
 * `applyEvents` and the cursor writes here, so the caller decides which queue
 * this runs on.
 */
export function runCodexLogTick(options: TickOptions): TickResult {
  const { db, now } = options
  const result: TickResult = { filesScanned: 0, filesRead: 0, eventsApplied: 0, firstSeen: 0, truncated: 0 }
  const warn = options.onWarn ?? ((m: string) => console.warn(m))

  const cursors = loadCursors(db, 'codex')
  const files = scanActiveFiles({
    now,
    sessionsDir: options.sessionsDir,
    scanDays: options.scanDays,
    activeWindowMs: options.activeWindowMs,
    knownFiles: recentCursorFiles(db, 'codex', now),
  })
  result.filesScanned = files.length

  for (const file of files) {
    const cursor = cursors.get(file)
    const read = readNewEvents(file, cursor, now)

    if (read.firstSight) {
      result.firstSeen++
      const header = readSessionHeader(file)
      // No status: this registers the session, it does not describe it.
      result.eventsApplied += options.applyEvents([{
        sessionId: read.sessionId,
        tool: 'codex',
        kind: 'process_scan',
        ts: now,
        source: 'log',
        detail: 'first_sight',
        cwd: header ? readCwd(header.payload) : undefined,
        payload: header
          ? sanitizePayload('session_meta', header.payload)
          : { event_type: 'first_sight' },
      }])
      saveCursor(db, file, 'codex', read.offset, read.size, now)
      continue
    }

    if (read.truncated) {
      result.truncated++
      warn(
        `[codex-log] ${file} shrank (${cursor?.last_size ?? 0} → ${read.size} bytes); ` +
        'resuming at the new end rather than replaying it'
      )
      saveCursor(db, file, 'codex', read.offset, read.size, now)
      continue
    }

    if (read.events.length > 0) {
      result.filesRead++
      result.eventsApplied += options.applyEvents(read.events)
    }
    if (cursor == null || read.offset !== cursor.byte_offset || read.size !== cursor.last_size) {
      saveCursor(db, file, 'codex', read.offset, read.size, now)
    }
  }

  return result
}
