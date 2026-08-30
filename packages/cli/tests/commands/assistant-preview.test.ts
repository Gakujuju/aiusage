import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * The reply text is the one field in a hook payload that is the conversation
 * itself. It is captured only when asked for, and it is cut down at capture —
 * the database must never hold the whole reply.
 */
const config = vi.hoisted(() => ({ value: undefined as unknown }))
vi.mock('../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config.js')>()
  return { ...actual, loadConfig: () => config.value }
})

const { buildAgentEvent } = await import('../../src/commands/agent-event.js')

const LONG = 'あ'.repeat(500)

function stopHook(extra: Record<string, unknown> = {}) {
  return {
    session_id: 's1',
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: LONG,
    // A field the whitelist genuinely does not cover, so the rest of
    // _droppedKeys can be asserted on independently.
    background_tasks: [],
    ...extra,
  }
}

describe('assistant preview capture (Claude Code hooks)', () => {
  beforeEach(() => { config.value = undefined })
  afterEach(() => { config.value = undefined })

  it('keeps nothing while the setting is off', () => {
    config.value = { notifications: { enabled: true } }
    const event = buildAgentEvent(stopHook(), {})

    expect(event?.payload?.assistant_preview).toBeUndefined()
    // Reported as dropped, like anything else outside the whitelist.
    expect(event?.payload?._droppedKeys).toContain('last_assistant_message')
    expect(JSON.stringify(event?.payload)).not.toContain('あ')
  })

  it('keeps nothing while the setting is merely truthy', () => {
    // An explicit true, not a value that happens to be non-empty. This one
    // sends conversation text off the machine.
    config.value = { notifications: { includeAssistantMessage: 'yes' } }
    expect(buildAgentEvent(stopHook(), {})?.payload?.assistant_preview).toBeUndefined()
  })

  it('captures a cut-down preview when the setting is on', () => {
    config.value = { notifications: { includeAssistantMessage: true } }
    const preview = buildAgentEvent(stopHook(), {})?.payload?.assistant_preview as string

    expect(typeof preview).toBe('string')
    // 200 characters plus the ellipsis that marks the cut.
    expect(preview.length).toBe(201)
    expect(preview.endsWith('…')).toBe(true)
    expect(preview.startsWith('あああ')).toBe(true)
  })

  it('never stores more than the cap, however long the reply', () => {
    config.value = { notifications: { includeAssistantMessage: true } }
    // A marker past the cap: if any of it survives, the full reply was stored.
    const message = 'x'.repeat(400) + 'MARKER-PAST-THE-CAP'
    const event = buildAgentEvent(stopHook({ last_assistant_message: message }), {})

    expect(JSON.stringify(event?.payload)).not.toContain('MARKER-PAST-THE-CAP')
    expect((event?.payload?.assistant_preview as string).length).toBe(201)
  })

  it('captures the one line worth showing, not the whole reply flattened', () => {
    config.value = { notifications: { includeAssistantMessage: true } }
    const event = buildAgentEvent(stopHook({
      last_assistant_message: '  done.\n\n  next:   two   things\n',
    }), {})

    expect(event?.payload?.assistant_preview).toBe('done.')
  })

  it('reaches past the cap for the line that states the outcome', () => {
    // The selection runs on the whole message before anything is trimmed, so
    // a conclusion buried after a long preamble still makes it into the
    // notification — while only that line is stored.
    config.value = { notifications: { includeAssistantMessage: true } }
    const event = buildAgentEvent(stopHook({
      last_assistant_message: 'あ'.repeat(400) + '\n完了報告: 直しました',
    }), {})

    expect(event?.payload?.assistant_preview).toBe('完了報告: 直しました')
    expect(JSON.stringify(event?.payload)).not.toContain('あああ')
  })

  it('keeps nothing for an empty or whitespace-only reply', () => {
    config.value = { notifications: { includeAssistantMessage: true } }
    expect(buildAgentEvent(stopHook({ last_assistant_message: '   \n ' }), {})?.payload?.assistant_preview)
      .toBeUndefined()
    expect(buildAgentEvent(stopHook({ last_assistant_message: 42 }), {})?.payload?.assistant_preview)
      .toBeUndefined()
  })

  it('captures nothing from any hook other than Stop', () => {
    // A finished turn is the only thing with a reply to show. The other hooks
    // must not start carrying conversation text because the setting is on.
    config.value = { notifications: { includeAssistantMessage: true } }
    for (const hook of ['SessionStart', 'UserPromptSubmit', 'Notification', 'StopFailure', 'SessionEnd']) {
      const event = buildAgentEvent({
        session_id: 's1', hook_event_name: hook, last_assistant_message: LONG,
      }, {})
      expect(event?.payload?.assistant_preview).toBeUndefined()
      expect(JSON.stringify(event?.payload)).not.toContain('あ')
    }
  })
})

describe('_droppedKeys and the assistant preview', () => {
  beforeEach(() => { config.value = undefined })
  afterEach(() => { config.value = undefined })

  it('does not list the source field once it has been consumed', () => {
    // _droppedKeys means "the whitelist has fallen behind". A field read into
    // a column or a derived value is not behind — it is handled. Same
    // reasoning as CONSUMED_FIELDS for session_id and cwd.
    config.value = { notifications: { includeAssistantMessage: true } }
    const payload = buildAgentEvent(stopHook(), {})?.payload as Record<string, unknown>

    expect(payload.assistant_preview).toBeDefined()
    expect(payload._droppedKeys ?? []).not.toContain('last_assistant_message')
    // Everything else the whitelist really does not cover is still listed.
    expect(payload._droppedKeys).toContain('background_tasks')
  })

  it('lists it when the setting is off, because it really was thrown away', () => {
    config.value = { notifications: { enabled: true } }
    const payload = buildAgentEvent(stopHook(), {})?.payload as Record<string, unknown>

    expect(payload.assistant_preview).toBeUndefined()
    expect(payload._droppedKeys).toContain('last_assistant_message')
  })

  it('lists it when the reply was empty and produced no preview', () => {
    config.value = { notifications: { includeAssistantMessage: true } }
    const payload = buildAgentEvent(stopHook({ last_assistant_message: '   ' }), {})
      ?.payload as Record<string, unknown>

    expect(payload.assistant_preview).toBeUndefined()
    expect(payload._droppedKeys).toContain('last_assistant_message')
  })
})
