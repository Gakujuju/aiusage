import { openSync, readSync, closeSync, statSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type Database from 'better-sqlite3'
import type { AgentEventInput } from '../db/agent-sessions.js'
import { extractSessionId } from '../commands/parse.js'
import { loadConfig } from '../config.js'
import { normalizeAssistantPreview } from '@aiusage/core'

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

/**
 * How new a session has to be for its whole file to be read on first sight.
 *
 * A session that started seconds ago has no backlog to replay, and starting
 * at the end of it loses the opening turn every time — measured: a session
 * whose session_meta and user_message were skipped ended up at turn_count 0.
 * Within ten minutes the cost of missing the first turn outweighs the risk of
 * replaying: ten minutes can be thousands of lines, but they are lines from
 * work happening right now, which is what there is to report.
 */
export const FRESH_SESSION_MS = 10 * 60 * 1000

/**
 * Size past which even a fresh file is tailed instead.
 *
 * Ten minutes does not produce five megabytes of rollout in normal use, so a
 * file this large is something other than what the rule was written for.
 */
export const FRESH_SESSION_MAX_BYTES = 5 * 1024 * 1024

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

/**
 * The reply text, kept only when the user has asked for it.
 *
 * Deliberately outside PAYLOAD_WHITELIST: everything there is safe by
 * construction, and this is the one field that is the conversation itself.
 */
const ASSISTANT_MESSAGE_FIELD: Record<string, string> = { task_complete: 'last_agent_message' }

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
export function eventForLine(
  line: CodexLogLine,
  sessionId: string,
  includeAssistantMessage = false,
): AgentEventInput | null {
  const base = {
    sessionId,
    tool: 'codex',
    ts: line.ts,
    source: 'log' as const,
    payload: sanitizePayload(line.eventType, line.payload, includeAssistantMessage),
    detail: line.eventType,
  }

  switch (line.eventType) {
    case 'session_meta':
      return { ...base, kind: 'session_start', cwd: projectCwd(readCwd(line.payload)) }
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
 * The cwd to record, or undefined when it names no project.
 *
 * The scratch directory is still the real working directory, but recording it
 * would name a project that does not exist. Leaving it unset leaves project
 * empty, and the notification simply omits the line.
 */
function projectCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined
  return isCodexScratchCwd(cwd) ? undefined : cwd
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
  includeAssistantMessage = false,
): Record<string, unknown> {
  const allowed = PAYLOAD_WHITELIST[eventType] ?? []
  const kept: Record<string, unknown> = { event_type: eventType }
  const dropped: string[] = []

  // Normalised at capture, so the full reply never reaches the database,
  // and stored under the same name the Claude Code hook client uses.
  const assistantField = includeAssistantMessage ? ASSISTANT_MESSAGE_FIELD[eventType] : undefined
  if (assistantField) {
    const preview = normalizeAssistantPreview(payload[assistantField])
    if (preview) kept.assistant_preview = preview
  }

  for (const [key, value] of Object.entries(payload)) {
    // Consumed into assistant_preview, so not dropped — the same reasoning as
    // CONSUMED_KEYS. With the setting off, or an empty reply, it really was
    // thrown away and belongs in the list.
    if (key === assistantField && kept.assistant_preview != null) continue
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

/**
 * When the session began, from the rollout filename.
 *
 * `rollout-2026-08-30T11-19-25-<uuid>.jsonl` — the leading stamp is the
 * session start. Deliberately not the file's birthtime: copying, syncing or
 * restoring from a backup rewrites birthtime, and a file that looks newly
 * created would then have its whole history replayed as live events. The name
 * survives all of that.
 *
 * Returns null when the name does not carry a stamp, which the caller reads
 * as "not known to be fresh" — the safe direction.
 */
export function sessionStartFromFilename(file: string): number | null {
  const name = file.split(/[\\/]/).pop() ?? ''
  const match = name.match(/^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-/)
  if (!match) return null
  const [, y, mo, d, h, mi, sec] = match
  // Local time: Codex writes the name from the local clock, and the whole
  // comparison is against Date.now() on the same machine.
  const ms = new Date(
    Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec),
  ).getTime()
  return Number.isFinite(ms) ? ms : null
}

/**
 * Codex Desktop's ad-hoc scratch directory, which is not a project.
 *
 * `<home>/Documents/Codex/<YYYY-MM-DD>/<n>` is where Codex Desktop puts a
 * session started without a folder. Named after the tool, it otherwise
 * resolves to the project "Codex" and the notification reads "プロジェクト:
 * Codex", as though such a project existed.
 *
 * Both the date and the numeric leaf are required, and the path has to be
 * under the home directory — someone with a real project at
 * Documents/Codex should keep it. Codex-specific, so it lives here rather
 * than in the shared extractProjectFromCwd.
 */
export function isCodexScratchCwd(cwd: string, home: string = homedir()): boolean {
  if (!cwd || !home) return false
  const norm = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '')
  const path = norm(cwd)
  const base = norm(home)
  if (!path.toLowerCase().startsWith(base.toLowerCase() + '/')) return false
  const rest = path.slice(base.length + 1)
  // The leaf is a sequence number, sometimes with a sub-index: the observed
  // value was '1-1', not '1'. Digits and hyphens only, so a directory with a
  // name someone chose still reads as a project.
  return /^Documents\/Codex\/\d{4}-\d{2}-\d{2}\/\d+(?:-\d+)*$/i.test(rest)
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
  /**
   * True the first time this file is seen.
   *
   * Usually means no events were produced. A file whose name says the session
   * started within FRESH_SESSION_MS is read from the start instead, so it can
   * be both first sight and carry events.
   */
  firstSight: boolean
  /** Fresh enough to read whole, but too large to be worth it. */
  oversizedFresh?: boolean
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
    const startedAt = sessionStartFromFilename(file)
    const fresh = startedAt != null && now - startedAt <= FRESH_SESSION_MS && now >= startedAt
    if (!fresh) {
      return { events: [], offset: size, size, truncated: false, firstSight: true, sessionId }
    }
    if (size > FRESH_SESSION_MAX_BYTES) {
      return {
        events: [], offset: size, size, truncated: false, firstSight: true,
        oversizedFresh: true, sessionId,
      }
    }
    // Fall through and read from 0: a session this new has no backlog, and
    // starting at the end would drop its opening turn.
  }

  // Both checks are about a cursor we already hold; a fresh first sight falls
  // through to read from zero and has neither an offset nor a previous size.
  if (cursor && size < cursor.last_size) {
    // Truncated or replaced. The stored offset points into a file that no
    // longer exists in that shape; resuming at 0 would replay what is left.
    return { events: [], offset: size, size, truncated: true, firstSight: false, sessionId }
  }

  if (cursor && size <= cursor.byte_offset) {
    return { events: [], offset: cursor.byte_offset, size, truncated: false, firstSight: false, sessionId }
  }

  const start = cursor?.byte_offset ?? 0
  const wanted = Math.min(size - start, MAX_READ_BYTES)
  const buffer = Buffer.allocUnsafe(wanted)
  let read = 0
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    read = readSync(fd, buffer, 0, wanted, start)
  } catch {
    return { events: [], offset: start, size, truncated: false, firstSight: cursor == null, sessionId }
  } finally {
    if (fd != null) closeSync(fd)
  }

  const chunk = buffer.subarray(0, read).toString('utf-8')
  // Stop at the last newline: anything after it is a line still being
  // written. Leaving it behind means the offset resumes at its start.
  const lastNewline = chunk.lastIndexOf('\n')
  if (lastNewline === -1) {
    return { events: [], offset: start, size, truncated: false, firstSight: cursor == null, sessionId }
  }

  const complete = chunk.slice(0, lastNewline)
  const consumed = Buffer.byteLength(complete, 'utf-8') + 1

  // Read once per file rather than per line.
  const includeAssistantMessage = loadConfig()?.notifications?.includeAssistantMessage === true
  const events: AgentEventInput[] = []
  for (const raw of complete.split('\n')) {
    const line = parseLine(raw)
    if (!line) continue
    const event = eventForLine(line, sessionId, includeAssistantMessage)
    if (event) events.push(event)
  }

  return { events, offset: start + consumed, size, truncated: false, firstSight: cursor == null, sessionId }
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

    if (read.oversizedFresh) {
      warn(
        `[codex-log] ${file} claims to have started within ` +
        `${Math.round(FRESH_SESSION_MS / 60000)} minutes but is already ` +
        `${Math.round(read.size / 1024 / 1024)} MB; tailing it instead of ` +
        'reading it whole'
      )
    }

    if (read.firstSight) {
      result.firstSeen++

      // A fresh session was read from the start, so its own session_meta is
      // already among the events. Registering it again would only overwrite
      // what those events said with a status-less placeholder.
      if (read.events.length === 0) {
        const header = readSessionHeader(file)
        // No status: this registers the session, it does not describe it.
        result.eventsApplied += options.applyEvents([{
          sessionId: read.sessionId,
          tool: 'codex',
          kind: 'process_scan',
          ts: now,
          source: 'log',
          detail: 'first_sight',
          cwd: header ? projectCwd(readCwd(header.payload)) : undefined,
          payload: header
            ? sanitizePayload('session_meta', header.payload)
            : { event_type: 'first_sight' },
        }])
      } else {
        result.filesRead++
        result.eventsApplied += options.applyEvents(read.events)
      }

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
