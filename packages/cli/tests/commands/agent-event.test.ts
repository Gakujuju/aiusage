import { describe, it, expect } from 'vitest'
import { buildAgentEvent, hookConfigSnippet, stopFailureMatcherSnippet } from '../../src/commands/agent-event.js'

describe('buildAgentEvent — hook mapping', () => {
  it('maps every Claude Code hook name we handle', () => {
    const cases: Array<[string, string]> = [
      ['SessionStart', 'session_start'],
      ['UserPromptSubmit', 'user_prompt'],
      ['PreToolUse', 'pre_tool_use'],
      ['PostToolUse', 'post_tool_use'],
      ['PermissionRequest', 'permission_request'],
      ['PermissionDenied', 'permission_denied'],
      ['Notification', 'notification'],
      ['Stop', 'stop'],
      ['StopFailure', 'stop_failure'],
      ['SubagentStop', 'subagent_stop'],
      ['SessionEnd', 'session_end'],
    ]
    for (const [hookName, kind] of cases) {
      const event = buildAgentEvent({ session_id: 's', hook_event_name: hookName }, {})
      expect(event?.kind).toBe(kind)
    }
  })

  it('returns null rather than guessing at an unknown hook', () => {
    expect(buildAgentEvent({ session_id: 's', hook_event_name: 'PostCompact' }, {})).toBeNull()
  })

  it('returns null without a session id', () => {
    expect(buildAgentEvent({ hook_event_name: 'Stop' }, {})).toBeNull()
  })

  it('lets --kind and --session-id override the payload', () => {
    const event = buildAgentEvent({}, { kind: 'heartbeat', sessionId: 'forced' })
    expect(event?.kind).toBe('heartbeat')
    expect(event?.sessionId).toBe('forced')
  })
})

describe('buildAgentEvent — payload whitelist', () => {
  const hook = {
    session_id: 's',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    message: 'may I',
    // Not on the whitelist — must be dropped by name only.
    tool_input: { command: 'cat ~/.ssh/id_rsa' },
    last_assistant_message: 'here is my secret plan',
    some_future_field: 'value-we-have-never-seen',
  }

  it('keeps only whitelisted fields', () => {
    const payload = buildAgentEvent(hook, {})!.payload!
    expect(payload.tool_name).toBe('Bash')
    expect(payload.message).toBe('may I')
    expect(payload.hook_event_name).toBe('PermissionRequest')
    expect(payload.tool_input).toBeUndefined()
    expect(payload.last_assistant_message).toBeUndefined()
    expect(payload.some_future_field).toBeUndefined()
  })

  it('records dropped keys by name, sorted, and never their values', () => {
    const payload = buildAgentEvent(hook, {})!.payload!
    expect(payload._droppedKeys).toEqual(['last_assistant_message', 'some_future_field', 'tool_input'])

    // The whole payload must not contain any dropped value, at any depth.
    const serialised = JSON.stringify(payload)
    expect(serialised).not.toContain('id_rsa')
    expect(serialised).not.toContain('secret plan')
    expect(serialised).not.toContain('value-we-have-never-seen')
  })

  it('omits _droppedKeys entirely when nothing was dropped', () => {
    const payload = buildAgentEvent({ session_id: 's', hook_event_name: 'Stop' }, {})!.payload!
    expect(payload._droppedKeys).toBeUndefined()
  })

  it('carries the permission fields it now whitelists', () => {
    const payload = buildAgentEvent({
      session_id: 's',
      hook_event_name: 'PermissionRequest',
      permission_suggestion: 'allow-once',
      tool_use_id: 'toolu_123',
    }, {})!.payload!
    expect(payload.permission_suggestion).toBe('allow-once')
    expect(payload.tool_use_id).toBe('toolu_123')
    expect(payload._droppedKeys).toBeUndefined()
  })
})

describe('hook config output', () => {
  it('covers every mapped hook, including the permission events', () => {
    const config = JSON.parse(hookConfigSnippet())
    expect(Object.keys(config.hooks).sort()).toEqual([
      'Notification', 'PermissionDenied', 'PermissionRequest', 'PostToolUse',
      'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'StopFailure',
      'SubagentStop', 'UserPromptSubmit',
    ])
    expect(config.hooks.Stop[0].hooks[0].command).toContain('aiusage agent-event')
  })

  it('offers a StopFailure split by error type', () => {
    const config = JSON.parse(stopFailureMatcherSnippet())
    const matchers = config.hooks.StopFailure.map((g: { matcher: string }) => g.matcher)
    expect(matchers).toEqual(['rate_limit|overloaded', 'authentication_failed|billing_error'])
  })
})
