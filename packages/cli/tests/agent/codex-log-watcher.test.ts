import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import Database from 'better-sqlite3'

// These tests describe the default: no reply text captured. Reading the real
// ~/.aiusage/config.json would make them pass or fail depending on whether
// the machine running them has the preview switched on.
vi.mock('../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config.js')>()
  return { ...actual, loadConfig: () => ({}) }
})
import { initializeDatabase } from '../../src/db/index.js'
import { applyAgentEvents } from '../../src/db/agent-sessions.js'
import { extractSessionId } from '../../src/commands/parse.js'
import {
  eventForLine,
  parseLine,
  sanitizePayload,
  scanActiveFiles,
  readNewEvents,
  readSessionHeader,
  runCodexLogTick,
  loadCursors,
  sessionStartFromFilename,
  isCodexScratchCwd,
  type CodexLogLine,
} from '../../src/agent/codex-log-watcher.js'

const NOW = 1_788_000_000_000
const SESSION_STAMP = '2026-08-30T01-27-17-01a04e58-cc48-7bd3-a0fc-9e3c51b8d9fc'
const FILE_NAME = `rollout-${SESSION_STAMP}.jsonl`

/**
 * `<root>/YYYY/MM/DD` for the local date of `at`.
 *
 * The scan window is relative to the clock the tick is given, so a fixture
 * directory named for a hard-coded date drops out of range as soon as the
 * two disagree — which is how the first version of these tests failed.
 */
function dayDirFor(root: string, at: number): string {
  const d = new Date(at)
  return join(
    root,
    String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  )
}

function metaLine(cwd = 'C:\\work\\proj'): string {
  return JSON.stringify({
    timestamp: '2026-08-30T01:27:17.634Z',
    type: 'session_meta',
    payload: {
      session_id: 'sid', id: '01a04e58', timestamp: '2026-08-30T01:27:17.450Z',
      cwd, originator: 'Codex Desktop', cli_version: '0.150.0',
      source: 'desktop', model_provider: 'openai', history_mode: 'full',
      base_instructions: { text: 'SYSTEM PROMPT TEXT' },
      git: { branch: 'main' },
      context_window: { total: 400000 },
    },
  })
}

function eventLine(type: string, extra: Record<string, unknown> = {}, ts = '2026-08-30T01:28:00.000Z'): string {
  return JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type, ...extra } })
}

const USER_LINE = eventLine('user_message', {
  message: 'SECRET PROMPT TEXT', local_images: [], text_elements: ['SECRET'],
})
const TASK_STARTED_LINE = eventLine('task_started', { turn_id: 't1', started_at: 1 })
const TASK_COMPLETE_LINE = eventLine('task_complete', {
  turn_id: 't1', started_at: 1, completed_at: 2, last_agent_message: 'SECRET REPLY',
}, '2026-08-30T01:29:00.000Z')
const AGENT_LINE = eventLine('agent_message', { message: 'SECRET REPLY' })

describe('parseLine', () => {
  it('collapses event_msg to its inner type', () => {
    expect(parseLine(TASK_STARTED_LINE)?.eventType).toBe('task_started')
    expect(parseLine(metaLine())?.eventType).toBe('session_meta')
  })

  it('returns null for a half-written line rather than throwing', () => {
    // The tail of a file being appended to. The cursor is not advanced past
    // it, so the next tick sees the whole line.
    expect(parseLine('{"timestamp":"2026-08-30T01:2')).toBeNull()
    expect(parseLine('')).toBeNull()
    expect(parseLine('   ')).toBeNull()
  })
})

describe('sanitizePayload', () => {
  it('keeps no conversation text from any line type', () => {
    const meta = sanitizePayload('session_meta', JSON.parse(metaLine()).payload)
    const user = sanitizePayload('user_message', JSON.parse(USER_LINE).payload)
    const done = sanitizePayload('task_complete', JSON.parse(TASK_COMPLETE_LINE).payload)

    const serialised = JSON.stringify([meta, user, done])
    expect(serialised).not.toContain('SECRET')
    expect(serialised).not.toContain('SYSTEM PROMPT')
    // '_droppedKeys' names the fields that were thrown away, which is the
    // point of it — so assert on the values, not on the key names.
    expect(JSON.stringify(Object.values(meta))).not.toContain('SECRET')
    expect(user.message).toBeUndefined()
    expect(done.last_agent_message).toBeUndefined()
  })

  it('keeps the whitelisted scalars and names what it dropped', () => {
    const meta = sanitizePayload('session_meta', JSON.parse(metaLine()).payload)

    expect(meta.event_type).toBe('session_meta')
    expect(meta.cli_version).toBe('0.150.0')
    expect(meta.originator).toBe('Codex Desktop')
    // Objects are dropped even when whitelisted elsewhere; these never were.
    expect(meta._droppedKeys).toEqual(expect.arrayContaining(['base_instructions', 'git', 'context_window']))
    // cwd goes to its own column, so it is consumed rather than dropped.
    expect(meta._droppedKeys).not.toContain('cwd')
  })

  it('drops a whitelisted key that arrives as an object', () => {
    // If Codex turns cli_version into a structure one day, the whitelist
    // alone would let whatever it contains through.
    const out = sanitizePayload('session_meta', { cli_version: { full: 'x', notes: 'SECRET' } })
    expect(JSON.stringify(out)).not.toContain('SECRET')
    expect(out._droppedKeys).toEqual(['cli_version'])
  })
})

describe('eventForLine', () => {
  const line = (raw: string): CodexLogLine => parseLine(raw)!

  it('maps only the four lifecycle lines', () => {
    expect(eventForLine(line(metaLine()), 's')?.kind).toBe('session_start')
    expect(eventForLine(line(USER_LINE), 's')?.kind).toBe('user_prompt')
    expect(eventForLine(line(TASK_STARTED_LINE), 's')?.kind).toBe('user_prompt')
    expect(eventForLine(line(TASK_COMPLETE_LINE), 's')?.kind).toBe('stop')
    expect(eventForLine(line(AGENT_LINE), 's')).toBeNull()
    expect(eventForLine(line(eventLine('token_count')), 's')).toBeNull()
  })

  it('counts a turn for user_message but not task_started', () => {
    expect(eventForLine(line(USER_LINE), 's')?.countsAsTurn).toBe(true)
    expect(eventForLine(line(TASK_STARTED_LINE), 's')?.countsAsTurn).toBe(false)
  })

  it('takes cwd from session_meta', () => {
    expect(eventForLine(line(metaLine('D:\\repo')), 's')?.cwd).toBe('D:\\repo')
  })

  it('marks every event as log-sourced', () => {
    expect(eventForLine(line(TASK_COMPLETE_LINE), 's')?.source).toBe('log')
  })
})

describe('file following', () => {
  let dir: string
  let db: Database.Database
  let file: string
  let warn: string[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codex-watch-'))
    const dayDir = dayDirFor(dir, NOW)
    mkdirSync(dayDir, { recursive: true })
    file = join(dayDir, FILE_NAME)
    db = new Database(':memory:')
    initializeDatabase(db)
    warn = []
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function tick(now = NOW) {
    return runCodexLogTick({
      db,
      now,
      sessionsDir: dir,
      // mtime is real wall-clock while `now` is fixed, so the age filter
      // would compare two different clocks. The directory filter is what
      // these tests are exercising.
      activeWindowMs: Number.MAX_SAFE_INTEGER,
      onWarn: (m) => warn.push(m),
      applyEvents: (events) => applyAgentEvents(db, events, {
        device: 'dev', deviceInstanceId: 'dii', platform: 'win32', now,
      }).applied,
    })
  }

  function sessionRow() {
    return db.prepare('SELECT * FROM agent_sessions').get() as any
  }

  it('produces no events from a file it has never seen', () => {
    // The file this was written against is 44 MB. Reading it from the start
    // would replay thousands of finished turns as live notifications.
    writeFileSync(file, [metaLine(), TASK_STARTED_LINE, USER_LINE, TASK_COMPLETE_LINE].join('\n') + '\n')

    const result = tick()

    expect(result.firstSeen).toBe(1)
    const events = db.prepare('SELECT kind FROM agent_session_events').all() as Array<{ kind: string }>
    // Exactly one, and it is the registration event, which claims no status.
    expect(events).toEqual([{ kind: 'process_scan' }])
    expect(sessionRow().status).toBe('unknown')
  })

  it('gives the session its cwd from the header without reading the backlog', () => {
    const cwd = 'C:\\Users\\me\\src\\myproj'
    writeFileSync(file, [metaLine(cwd), USER_LINE].join('\n') + '\n')

    tick()

    const row = sessionRow()
    expect(row.cwd).toBe(cwd)
    // The shared extractor, not a Codex-specific one — the project name has to
    // match what the parser writes or the two views disagree. 'src' is a known
    // workspace root, so the segment under it wins; 'Desktop' is not, so a
    // project under Desktop is named 'Desktop' until config.projectRoots says
    // otherwise. That is the existing behaviour for every tool.
    expect(row.project).toBe('myproj')
    expect(row.turn_count).toBe(0)
  })

  it('starts the cursor at the end of the file', () => {
    writeFileSync(file, [metaLine(), USER_LINE].join('\n') + '\n')

    tick()

    const cursor = loadCursors(db, 'codex').get(file)!
    expect(cursor.byte_offset).toBe(statSync(file).size)
  })

  it('turns only what was appended into events', () => {
    writeFileSync(file, [metaLine(), USER_LINE, TASK_COMPLETE_LINE].join('\n') + '\n')
    tick()

    appendFileSync(file, [TASK_STARTED_LINE, USER_LINE, AGENT_LINE, TASK_COMPLETE_LINE].join('\n') + '\n')
    const result = tick(NOW + 1000)

    const kinds = (db.prepare('SELECT kind FROM agent_session_events ORDER BY rowid').all() as Array<{ kind: string }>)
      .map((r) => r.kind)
    expect(kinds).toEqual(['process_scan', 'user_prompt', 'user_prompt', 'stop'])
    expect(result.truncated).toBe(0)
  })

  it('counts one turn per user_message even though task_started shares the status', () => {
    writeFileSync(file, metaLine() + '\n')
    tick()

    // Each turn needs later timestamps than the last: an event at or before
    // status_since is rejected as describing a moment already passed.
    const turn = (minute: number) => [
      eventLine('task_started', { turn_id: `t${minute}` }, `2026-08-30T01:${minute}:00.000Z`),
      eventLine('user_message', { message: 'SECRET' }, `2026-08-30T01:${minute}:01.000Z`),
    ].join('\n') + '\n'

    appendFileSync(file, turn(31))
    tick(NOW + 1000)
    expect(sessionRow().turn_count).toBe(1)

    appendFileSync(file, eventLine('task_complete', { turn_id: 't31' }, '2026-08-30T01:32:00.000Z') + '\n')
    tick(NOW + 2000)

    appendFileSync(file, turn(33))
    tick(NOW + 3000)
    expect(sessionRow().turn_count).toBe(2)
  })

  it('walks the session through running and back to waiting', () => {
    writeFileSync(file, metaLine() + '\n')
    tick()

    appendFileSync(file, [TASK_STARTED_LINE, USER_LINE].join('\n') + '\n')
    tick(NOW + 1000)
    expect(sessionRow().status).toBe('running')

    appendFileSync(file, TASK_COMPLETE_LINE + '\n')
    tick(NOW + 2000)
    expect(sessionRow().status).toBe('waiting_for_user')
  })

  it('does not replay a file that shrank', () => {
    writeFileSync(file, [metaLine(), USER_LINE, TASK_COMPLETE_LINE].join('\n') + '\n')
    tick()
    appendFileSync(file, [TASK_STARTED_LINE, USER_LINE].join('\n') + '\n')
    tick(NOW + 1000)
    const before = (db.prepare('SELECT COUNT(*) AS n FROM agent_session_events').get() as { n: number }).n

    // Rotated, or replaced by a shorter file reusing the name.
    writeFileSync(file, metaLine() + '\n')
    const result = tick(NOW + 2000)

    expect(result.truncated).toBe(1)
    expect(warn).toHaveLength(1)
    expect(warn[0]).toContain('shrank')
    expect((db.prepare('SELECT COUNT(*) AS n FROM agent_session_events').get() as { n: number }).n).toBe(before)
    expect(loadCursors(db, 'codex').get(file)!.byte_offset).toBe(statSync(file).size)
  })

  it('resumes from the stored cursor after a restart', () => {
    writeFileSync(file, metaLine() + '\n')
    tick()
    appendFileSync(file, [USER_LINE].join('\n') + '\n')
    tick(NOW + 1000)

    // A fresh process reads the same cursor table and must not start over.
    const cursorBefore = loadCursors(db, 'codex').get(file)!
    appendFileSync(file, TASK_COMPLETE_LINE + '\n')
    const result = tick(NOW + 2000)

    expect(result.firstSeen).toBe(0)
    expect(loadCursors(db, 'codex').get(file)!.byte_offset).toBeGreaterThan(cursorBefore.byte_offset)
    const kinds = (db.prepare('SELECT kind FROM agent_session_events ORDER BY rowid').all() as Array<{ kind: string }>)
      .map((r) => r.kind)
    expect(kinds).toEqual(['process_scan', 'user_prompt', 'stop'])
  })

  it('holds back a line that is still being written', () => {
    writeFileSync(file, metaLine() + '\n')
    tick()

    appendFileSync(file, USER_LINE + '\n' + '{"timestamp":"2026-08-30T01:3')
    tick(NOW + 1000)
    expect((db.prepare('SELECT COUNT(*) AS n FROM agent_session_events').get() as { n: number }).n).toBe(2)

    // The rest of the line arrives.
    appendFileSync(file, '0:00.000Z","type":"event_msg","payload":{"type":"task_complete"}}\n')
    tick(NOW + 2000)
    const kinds = (db.prepare('SELECT kind FROM agent_session_events ORDER BY rowid').all() as Array<{ kind: string }>)
      .map((r) => r.kind)
    expect(kinds).toEqual(['process_scan', 'user_prompt', 'stop'])
  })

  it('stores no conversation text in any event payload', () => {
    writeFileSync(file, metaLine() + '\n')
    tick()
    appendFileSync(file, [TASK_STARTED_LINE, USER_LINE, AGENT_LINE, TASK_COMPLETE_LINE].join('\n') + '\n')
    tick(NOW + 1000)

    const rows = db.prepare('SELECT payload FROM agent_session_events').all() as Array<{ payload: string }>
    const all = rows.map((r) => r.payload).join('\n')
    expect(all).not.toContain('SECRET')
    expect(all).not.toContain('SYSTEM PROMPT')
  })

  it('uses the same session id the parser derives', () => {
    writeFileSync(file, metaLine() + '\n')
    tick()

    expect(sessionRow().agent_session_id).toBe(extractSessionId(file, 'codex'))
    expect(sessionRow().agent_session_id).toBe(SESSION_STAMP)
  })
})

describe('scanActiveFiles', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codex-scan-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function put(at: number, name: string): string {
    const dayDir = dayDirFor(dir, at)
    mkdirSync(dayDir, { recursive: true })
    const file = join(dayDir, name)
    writeFileSync(file, '{}\n')
    return file
  }

  it('ignores files nothing has touched recently', () => {
    const now = Date.now()
    const fresh = put(now, 'rollout-fresh.jsonl')

    expect(scanActiveFiles({ now, sessionsDir: dir })).toEqual([fresh])

    // Same file, judged against a clock two hours later.
    expect(scanActiveFiles({
      now: now + 2 * 60 * 60 * 1000, sessionsDir: dir,
    })).toEqual([])
  })

  it('follows a known file whose directory is outside the scan window', () => {
    // Directories are named for the day a session started. A session opened
    // days ago and still being written to would otherwise be dropped — which
    // is exactly the long-running session worth watching.
    const old = put(Date.now() - 400 * 24 * 60 * 60 * 1000, 'rollout-old.jsonl')

    expect(scanActiveFiles({ now: Date.now(), sessionsDir: dir, scanDays: 2 })).toEqual([])
    expect(scanActiveFiles({
      now: Date.now(), sessionsDir: dir, scanDays: 2, knownFiles: [old],
    })).toEqual([old])
  })

  it('ignores files that are not rollout logs', () => {
    put(Date.now(), 'notes.txt')
    put(Date.now(), 'rollout-x.json')
    expect(scanActiveFiles({ now: Date.now(), sessionsDir: dir })).toEqual([])
  })

  it('returns nothing when the sessions directory does not exist', () => {
    expect(scanActiveFiles({ now: Date.now(), sessionsDir: join(dir, 'nope') })).toEqual([])
  })
})

describe('readSessionHeader', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'codex-head-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads the first line only', () => {
    const file = join(dir, FILE_NAME)
    writeFileSync(file, [metaLine('C:\\a'), USER_LINE].join('\n') + '\n')
    expect(readSessionHeader(file)?.payload.cwd).toBe('C:\\a')
  })

  it('returns null when the first line is not a session_meta', () => {
    const file = join(dir, FILE_NAME)
    writeFileSync(file, USER_LINE + '\n')
    expect(readSessionHeader(file)).toBeNull()
  })
})

describe('readNewEvents', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'codex-read-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reports first sight without opening the backlog', () => {
    const file = join(dir, FILE_NAME)
    writeFileSync(file, [metaLine(), USER_LINE, TASK_COMPLETE_LINE].join('\n') + '\n')

    const result = readNewEvents(file, undefined, NOW)
    expect(result.firstSight).toBe(true)
    expect(result.events).toEqual([])
    expect(result.offset).toBe(statSync(file).size)
  })

  it('survives a file that vanished between the scan and the read', () => {
    const result = readNewEvents(join(dir, 'gone.jsonl'), undefined, NOW)
    expect(result.events).toEqual([])
    expect(result.firstSight).toBe(false)
  })
})

describe('sessionStartFromFilename', () => {
  it('reads the stamp Codex puts at the front of the name', () => {
    expect(sessionStartFromFilename(`/a/b/rollout-${SESSION_STAMP}.jsonl`))
      .toBe(new Date(2026, 7, 30, 1, 27, 17).getTime())
    expect(sessionStartFromFilename('C:\\dir\\rollout-2026-08-30T11-19-25-01a05076.jsonl'))
      .toBe(new Date(2026, 7, 30, 11, 19, 25).getTime())
  })

  it('returns null for anything it cannot read, so the caller tails', () => {
    expect(sessionStartFromFilename('/a/rollout-nope.jsonl')).toBeNull()
    expect(sessionStartFromFilename('/a/session.jsonl')).toBeNull()
    expect(sessionStartFromFilename('')).toBeNull()
  })
})

describe('isCodexScratchCwd', () => {
  const home = 'C:\\Users\\me'

  it('recognises the Desktop scratch directory', () => {
    expect(isCodexScratchCwd('C:\\Users\\me\\Documents\\Codex\\2026-08-30\\1', home)).toBe(true)
    expect(isCodexScratchCwd('C:\\Users\\me\\Documents\\Codex\\2026-08-30\\12', home)).toBe(true)
    expect(isCodexScratchCwd('/home/me/Documents/Codex/2026-08-30/1', '/home/me')).toBe(true)
    // What the real one looked like: the leaf carries a sub-index.
    expect(isCodexScratchCwd('C:\\Users\\me\\Documents\\Codex\\2026-08-30\\1-1', home)).toBe(true)
    expect(isCodexScratchCwd('C:\\Users\\me\\Documents\\Codex\\2026-08-30\\12-3', home)).toBe(true)
  })

  it('leaves a real project under Documents/Codex alone', () => {
    // Both the date and the numeric leaf are required, or someone who keeps
    // their work at Documents/Codex loses their project name.
    expect(isCodexScratchCwd('C:\\Users\\me\\Documents\\Codex', home)).toBe(false)
    expect(isCodexScratchCwd('C:\\Users\\me\\Documents\\Codex\\my-app', home)).toBe(false)
    expect(isCodexScratchCwd('C:\\Users\\me\\Documents\\Codex\\2026-08-30', home)).toBe(false)
    expect(isCodexScratchCwd('C:\\Users\\me\\Documents\\Codex\\2026-08-30\\1\\src', home)).toBe(false)
    expect(isCodexScratchCwd('C:\\Users\\me\\Documents\\Codex\\notes\\1', home)).toBe(false)
    expect(isCodexScratchCwd('C:\\Users\\me\\Documents\\Codex\\2026-08-30\\draft-1', home)).toBe(false)
  })

  it('requires the path to be under the home directory', () => {
    expect(isCodexScratchCwd('D:\\Documents\\Codex\\2026-08-30\\1', home)).toBe(false)
    expect(isCodexScratchCwd('C:\\Users\\other\\Documents\\Codex\\2026-08-30\\1', home)).toBe(false)
  })

  it('leaves an ordinary project directory alone', () => {
    expect(isCodexScratchCwd('C:\\Users\\me\\Desktop\\shijo-parking-guide', home)).toBe(false)
  })
})

describe('a session that just started', () => {
  let dir: string
  let db: Database.Database
  let warn: string[]
  let now: number

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codex-fresh-'))
    db = new Database(':memory:')
    initializeDatabase(db)
    warn = []
    now = Date.now()
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /** A rollout file whose name says the session started agoMs ago. */
  function fileStartedAgo(agoMs: number, lines: string[], pad = 0): string {
    const at = new Date(now - agoMs)
    const two = (n: number) => String(n).padStart(2, '0')
    const stamp =
      `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T` +
      `${two(at.getHours())}-${two(at.getMinutes())}-${two(at.getSeconds())}`
    const dayDir = dayDirFor(dir, now)
    mkdirSync(dayDir, { recursive: true })
    const file = join(dayDir, `rollout-${stamp}-01a04e58-cafe.jsonl`)
    let body = lines.join('\n') + '\n'
    if (pad > 0) {
      // Padding goes in as complete lines the mapper ignores, so the file grows
      // without changing which events it would produce.
      const filler = JSON.stringify({
        timestamp: at.toISOString(),
        type: 'response_item',
        payload: { type: 'x', pad: 'y'.repeat(500) },
      })
      while (body.length < pad) body += filler + '\n'
    }
    writeFileSync(file, body)
    return file
  }

  function tick(config?: { device?: string; platform?: string }) {
    return runCodexLogTick({
      db,
      now,
      sessionsDir: dir,
      activeWindowMs: Number.MAX_SAFE_INTEGER,
      onWarn: (m) => warn.push(m),
      applyEvents: (events) => applyAgentEvents(db, events, {
        // Matching this machine's config, where Desktop holds the projects.
        projectRoots: ['Desktop'],
        device: config?.device ?? 'dev',
        deviceInstanceId: 'dii',
        platform: config?.platform ?? 'win32',
        now,
      }).applied,
    })
  }

  function sessionRow() {
    return db.prepare("SELECT * FROM agent_sessions WHERE tool = 'codex'").get() as any
  }

  function kinds(): string[] {
    return (db.prepare('SELECT kind FROM agent_session_events ORDER BY rowid').all() as Array<{ kind: string }>)
      .map((r) => r.kind)
  }

  const TURN = [metaLine(), TASK_STARTED_LINE, USER_LINE, TASK_COMPLETE_LINE]

  it('reads a file from the start when its name says it began minutes ago', () => {
    // Tailing a brand-new file loses its opening turn every time: measured on
    // a real session, session_meta and user_message were skipped and the row
    // sat at turn_count 0 with only task_complete recorded.
    fileStartedAgo(60_000, TURN)

    const result = tick()

    expect(result.firstSeen).toBe(1)
    expect(kinds()).toEqual(['session_start', 'user_prompt', 'user_prompt', 'stop'])
    expect(sessionRow().turn_count).toBe(1)
    expect(sessionRow().status).toBe('waiting_for_user')
  })

  it('tails a file whose session started before the window', () => {
    fileStartedAgo(11 * 60_000, TURN)

    const result = tick()

    expect(result.firstSeen).toBe(1)
    expect(kinds()).toEqual(['process_scan'])
    expect(sessionRow().status).toBe('unknown')
    expect(sessionRow().turn_count).toBe(0)
  })

  it('tails a fresh file that is already too large, and says so', () => {
    // Ten minutes does not produce five megabytes in normal use, so whatever
    // this is, it is not the case the exception was written for.
    fileStartedAgo(60_000, TURN, 6 * 1024 * 1024)

    tick()

    expect(kinds()).toEqual(['process_scan'])
    expect(warn).toHaveLength(1)
    expect(warn[0]).toContain('MB')
  })

  it('tails a file whose name carries no timestamp', () => {
    // An unreadable name means unknown age, and unknown age counts as old.
    const dayDir = dayDirFor(dir, now)
    mkdirSync(dayDir, { recursive: true })
    writeFileSync(join(dayDir, 'rollout-mystery.jsonl'), TURN.join('\n') + '\n')

    tick()

    expect(kinds()).toEqual(['process_scan'])
  })

  it('does not re-read a fresh file on the next tick', () => {
    const file = fileStartedAgo(60_000, TURN)
    tick()
    const after = kinds().length

    tick()
    expect(kinds()).toHaveLength(after)
    expect(loadCursors(db, 'codex').get(file)!.byte_offset).toBe(statSync(file).size)
  })

  it('names the device from config rather than the host', () => {
    fileStartedAgo(60_000, TURN)
    tick({ device: '自宅PC' })
    expect(sessionRow().device).toBe('自宅PC')
  })

  it('lets a later event correct a device recorded under the wrong name', () => {
    // The watcher shipped filling this with hostname(), so an existing row can
    // hold a name the user never chose. It has to be able to change.
    const file = fileStartedAgo(60_000, [metaLine()])
    tick({ device: 'DESKTOP-QOS4C85' })
    expect(sessionRow().device).toBe('DESKTOP-QOS4C85')

    appendFileSync(file, [TASK_STARTED_LINE, USER_LINE].join('\n') + '\n')
    tick({ device: '自宅PC' })
    expect(sessionRow().device).toBe('自宅PC')
  })

  it('leaves the project empty for the Codex Desktop scratch directory', () => {
    const scratch = join(homedir(), 'Documents', 'Codex', '2026-08-30', '1-1')
    fileStartedAgo(60_000, [metaLine(scratch), TASK_STARTED_LINE, USER_LINE, TASK_COMPLETE_LINE])

    tick()

    const row = sessionRow()
    expect(row.project).toBe('')
    // cwd goes with it: recording it would only name a project that is not
    // one, and it is an absolute path nothing else needs.
    expect(row.cwd).toBe('')
  })

  it('still resolves the project when Codex runs in a real one', () => {
    const real = join(homedir(), 'Desktop', 'shijo-parking-guide')
    fileStartedAgo(60_000, [metaLine(real), TASK_STARTED_LINE, USER_LINE])

    tick()

    const row = sessionRow()
    expect(row.cwd).toBe(real)
    expect(row.project).toBe('shijo-parking-guide')
  })
})
