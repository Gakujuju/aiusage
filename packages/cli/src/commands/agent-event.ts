import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostname, platform } from 'node:os'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { AIUSAGE_DIR, loadConfig } from '../config.js'
import { getIngestToken, getState } from '../init.js'
import { applyAgentEvents, type AgentEventInput, type AgentSessionEmitter } from '../db/agent-sessions.js'
import { normalizeAssistantPreview } from '@aiusage/core'

/**
 * The client a Claude Code hook runs.
 *
 * The one rule that overrides everything else here: this must never make the
 * agent wait. A hook that hangs makes Claude Code hang. So the HTTP call gets
 * one second, every failure is swallowed, the exit code is always 0, and
 * nothing is written to stderr. If the post does not land, the event goes to a
 * spool file and `serve` replays it later — dedupeKey makes that safe.
 */

const SPOOL_PATH = join(AIUSAGE_DIR, 'agent-events.spool.jsonl')
const PORT_FILE = join(AIUSAGE_DIR, '.serve-port')
const HTTP_TIMEOUT_MS = 1000

/** Beyond this the spool is more likely to be a leak than a buffer. */
const MAX_SPOOL_LINES = 5000

/** Claude Code hook event name → our tool-independent vocabulary. */
const HOOK_EVENT_KINDS: Record<string, string> = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt',
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  PermissionRequest: 'permission_request',
  PermissionDenied: 'permission_denied',
  Notification: 'notification',
  Stop: 'stop',
  StopFailure: 'stop_failure',
  SubagentStop: 'subagent_stop',
  SessionEnd: 'session_end',
}

/**
 * Hook fields worth keeping. Anything else is dropped by name into
 * payload._droppedKeys, so an upstream addition is visible without ever
 * being stored.
 */
const PAYLOAD_FIELDS = new Set([
  'hook_event_name', 'source', 'reason', 'message', 'notification_type',
  'tool_name', 'error_type', 'permission_mode', 'transcript_path',
  'stop_hook_active', 'prompt_id',
  // Permission events.
  'permission_suggestion', 'tool_use_id', 'agent_type',
])

/**
 * The reply text, per tool, kept only when the user has asked for it.
 *
 * Never whitelisted outright: this is the conversation, and it is the one
 * field in the payload that is worth being careful about. When
 * notifications.includeAssistantMessage is off it stays in _droppedKeys
 * like anything else the whitelist does not cover.
 */
const ASSISTANT_MESSAGE_FIELD: Record<string, string> = { stop: 'last_assistant_message' }

/**
 * Read into a column of their own rather than the payload. Not "dropped" —
 * listing them would make _droppedKeys noise instead of a signal that the
 * whitelist has fallen behind.
 */
const CONSUMED_FIELDS = new Set(['session_id', 'cwd'])

export interface AgentEventOptions {
  tool?: string
  kind?: string
  sessionId?: string
  status?: string
  detail?: string
  printHookConfig?: boolean
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf-8')
}

/** Hook stdin is UTF-8 and may carry a BOM on Windows. */
function parseHookJson(raw: string): Record<string, unknown> {
  const text = raw.replace(/^﻿/, '').trim()
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/**
 * Build the event. Every field is optional in practice: a hook payload we do
 * not recognise still produces a usable event rather than throwing.
 */
export function buildAgentEvent(
  hook: Record<string, unknown>,
  options: AgentEventOptions,
): AgentEventInput | null {
  const hookEventName = typeof hook.hook_event_name === 'string' ? hook.hook_event_name : ''
  const kind = options.kind || HOOK_EVENT_KINDS[hookEventName] || ''
  if (!kind) return null

  const sessionId = options.sessionId
    || (typeof hook.session_id === 'string' ? hook.session_id : '')
  if (!sessionId) return null

  // Only the fields we actually use — the rest of the hook payload is not
  // copied wholesale, so a future field carrying secrets cannot leak in.
  const payload: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const key of Object.keys(hook)) {
    if (PAYLOAD_FIELDS.has(key)) payload[key] = hook[key]
    else if (!CONSUMED_FIELDS.has(key)) dropped.push(key)
  }
  // Names only, never values. Enough to notice the whitelist has fallen behind
  // an upstream change without having to capture a raw dump to find out.
  if (dropped.length > 0) payload._droppedKeys = dropped.sort()

  // Normalised here, at capture, so the full reply never reaches the
  // database. Stored under one name regardless of tool so nothing
  // downstream has to know which hook it came from.
  if (loadConfig()?.notifications?.includeAssistantMessage === true) {
    const field = ASSISTANT_MESSAGE_FIELD[kind]
    const preview = field ? normalizeAssistantPreview(hook[field]) : null
    if (preview) payload.assistant_preview = preview
  }

  const detail = options.detail
    ?? (typeof hook.tool_name === 'string' ? hook.tool_name : undefined)
    ?? (typeof hook.message === 'string' ? hook.message : undefined)
    ?? (typeof hook.error_type === 'string' ? hook.error_type : undefined)

  return {
    sessionId,
    tool: options.tool || 'claude-code',
    kind: kind as AgentEventInput['kind'],
    status: options.status as AgentEventInput['status'],
    ts: Date.now(),
    source: 'hook',
    cwd: typeof hook.cwd === 'string' ? hook.cwd : undefined,
    pid: process.ppid,
    device: loadConfig()?.device || hostname() || '',
    deviceInstanceId: getState(AIUSAGE_DIR)?.deviceInstanceId ?? '',
    platform: loadConfig()?.platform || platform(),
    detail,
    payload,
    // Stable per invocation so a spooled retry is recognised as the same event.
    dedupeKey: `${sessionId}:${kind}:${Date.now()}:${randomUUID().slice(0, 8)}`,
  }
}

function readPort(): number | null {
  try {
    const port = parseInt(readFileSync(PORT_FILE, 'utf-8').trim(), 10)
    return Number.isFinite(port) ? port : null
  } catch {
    return null
  }
}

function spool(event: AgentEventInput): void {
  try {
    appendFileSync(SPOOL_PATH, JSON.stringify(event) + '\n', { encoding: 'utf-8', mode: 0o600 })
  } catch {
    // Nothing sensible to do. Losing an event is strictly better than
    // interfering with the agent.
  }
}

async function post(port: number, token: string, events: AgentEventInput[]): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/agent/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Aiusage-Token': token },
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Everything here is best-effort; the caller always exits 0. */
export async function sendAgentEvent(event: AgentEventInput): Promise<'sent' | 'spooled'> {
  const port = readPort()
  const token = getIngestToken(AIUSAGE_DIR)
  if (port == null || !token) {
    spool(event)
    return 'spooled'
  }

  // Carry any backlog along, so a recovered connection catches up without
  // waiting for serve to restart.
  const pending = readSpool()
  const batch = pending.length > 0 ? [...pending.slice(0, 199), event] : [event]

  if (await post(port, token, batch)) {
    if (pending.length > 0) clearSpool()
    return 'sent'
  }
  spool(event)
  return 'spooled'
}

function readSpool(): AgentEventInput[] {
  if (!existsSync(SPOOL_PATH)) return []
  try {
    return readFileSync(SPOOL_PATH, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .slice(-MAX_SPOOL_LINES)
      .map((line) => {
        try { return JSON.parse(line) as AgentEventInput } catch { return null }
      })
      .filter((e): e is AgentEventInput => e != null)
  } catch {
    return []
  }
}

function clearSpool(): void {
  try { unlinkSync(SPOOL_PATH) } catch {}
}

/**
 * Replay buffered events straight into the database. Called by serve at
 * startup, when there is no HTTP server to post to yet.
 */
export function drainAgentEventSpool(db: Database.Database, emitter?: AgentSessionEmitter): number {
  const events = readSpool()
  if (events.length === 0) return 0

  const result = applyAgentEvents(db, events, {
    device: loadConfig()?.device || hostname() || '',
    deviceInstanceId: getState(AIUSAGE_DIR)?.deviceInstanceId ?? '',
    platform: loadConfig()?.platform || platform(),
    now: Date.now(),
    storePromptPreview: loadConfig()?.agentSessions?.storePromptPreview === true,
    projectRoots: loadConfig()?.projectRoots,
  }, emitter)

  clearSpool()
  return result.applied + result.skipped
}

/** A ready-made settings.json fragment, printed rather than written. */
export function hookConfigSnippet(): string {
  const command = 'aiusage agent-event --tool claude-code'
  const hooks: Record<string, unknown> = {}
  for (const event of Object.keys(HOOK_EVENT_KINDS)) {
    hooks[event] = [{ hooks: [{ type: 'command', command }] }]
  }
  return JSON.stringify({ hooks }, null, 2)
}

/**
 * StopFailure's matcher filters by error type, which is a sharper tool than
 * classifying the error on our side after the fact.
 */
export function stopFailureMatcherSnippet(): string {
  return JSON.stringify({
    hooks: {
      StopFailure: [
        {
          matcher: 'rate_limit|overloaded',
          hooks: [{ type: 'command', command: `${command()} --kind stop_failure --detail rate_limited` }],
        },
        {
          matcher: 'authentication_failed|billing_error',
          hooks: [{ type: 'command', command: `${command()} --kind stop_failure --detail account_problem` }],
        },
      ],
    },
  }, null, 2)
}

function command(): string {
  return 'aiusage agent-event --tool claude-code'
}

export async function runAgentEvent(options: AgentEventOptions): Promise<void> {
  if (options.printHookConfig) {
    console.log('# Add these entries to ~/.claude/settings.json.')
    console.log('# Existing hooks on the same events keep working — Claude Code')
    console.log('# runs every hook registered for an event, each with its own stdin.')
    console.log(hookConfigSnippet())
    console.log('')
    console.log('# PermissionRequest and PermissionDenied may not fire on every build.')
    console.log('# They cost nothing if absent, and when present they identify a')
    console.log('# permission wait outright instead of guessing from the message text.')
    console.log('')
    console.log('# Optional: split StopFailure by error type instead of classifying')
    console.log('# it afterwards. Replaces the plain StopFailure entry above.')
    console.log(stopFailureMatcherSnippet())
    return
  }

  try {
    const hook = parseHookJson(await readStdin())
    const event = buildAgentEvent(hook, options)
    if (event) await sendAgentEvent(event)
  } catch {
    // Deliberately silent: see the note at the top of this file.
  }
}
