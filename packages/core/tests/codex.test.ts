import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CodexParser } from '../src/parsers/codex.js'
import type { ParseContext } from '../src/types.js'

const fixturePath = join(__dirname, 'fixtures/codex/sample.jsonl')
const lines = readFileSync(fixturePath, 'utf-8').split('\n').filter(Boolean)

describe('CodexParser', () => {
  const baseContext: ParseContext = {
    sourceFile: fixturePath,
    lineOffset: 0,
    sessionId: 'rollout-abc123',
    tool: 'codex',
    now: 1776738085700,
    device: 'test-device',
    deviceInstanceId: 'device-123',
  }

  it('skips session init line', () => {
    const parser = new CodexParser()
    const result = parser.parseLine(lines[0], { ...baseContext, lineOffset: 0 })
    expect(result).toBeNull()
  })

  it('skips function_call lines (stored as pending)', () => {
    const parser = new CodexParser()
    const result = parser.parseLine(lines[1], { ...baseContext, lineOffset: lines[0].length + 1 })
    expect(result).toBeNull()
  })

  it('parses token_count line and associates pending tool calls', () => {
    const parser = new CodexParser()
    // Parse function_call first
    parser.parseLine(lines[1], { ...baseContext, lineOffset: lines[0].length + 1 })
    // Parse token_count
    const result = parser.parseLine(lines[2], { ...baseContext, lineOffset: lines[0].length + lines[1].length + 2 })
    expect(result).not.toBeNull()
    expect(result!.record.model).toBe('gpt-4o')
    expect(result!.record.inputTokens).toBe(100)
    expect(result!.record.outputTokens).toBe(50)
    expect(result!.record.cacheReadTokens).toBe(0)
    // 0, not the 20 the fixture reports: reasoning_output_tokens is part of
    // output_tokens, so charging it separately billed it twice.
    expect(result!.record.thinkingTokens).toBe(0)
    expect(result!.record.cacheWriteTokens).toBe(0)
    expect(result!.record.costSource).toBe('pricing')
    expect(result!.toolCalls).toHaveLength(1)
    expect(result!.toolCalls[0].name).toBe('Read')
    expect(result!.toolCalls[0].recordId).toBe(result!.record.id)
  })

  it('associates multiple tool calls with one token_count', () => {
    const parser = new CodexParser()
    // Parse two function_calls
    parser.parseLine(lines[1], { ...baseContext, lineOffset: lines[0].length + 1 })
    parser.parseLine(lines[3], { ...baseContext, lineOffset: lines[0].length + lines[1].length + 2 })
    // Parse token_count
    const result = parser.parseLine(lines[4], { ...baseContext, lineOffset: lines[0].length + lines[1].length + lines[2].length + lines[3].length + 4 })
    expect(result!.toolCalls).toHaveLength(2)
    expect(result!.toolCalls[0].name).toBe('Read')
    expect(result!.toolCalls[0].callIndex).toBe(0)
    expect(result!.toolCalls[1].name).toBe('Bash')
    expect(result!.toolCalls[1].callIndex).toBe(1)
  })

  it('handles orphan tool calls on finalize', () => {
    const parser = new CodexParser()
    // Parse function_call that won't be associated
    parser.parseLine(lines[5], { ...baseContext, lineOffset: lines[0].length + lines[1].length + lines[2].length + lines[3].length + lines[4].length + 5 })
    const results = parser.finalize()
    expect(results).toHaveLength(1)
    expect(results[0].record).toBeNull()
    expect(results[0].toolCalls).toHaveLength(1)
    expect(results[0].toolCalls[0].name).toBe('Edit')
    expect(results[0].toolCalls[0].recordId).toBeNull()
  })

  it('parses response_item function_call format and associates pending tool calls', () => {
    const parser = new CodexParser()
    const functionCall = JSON.stringify({
      timestamp: '2026-05-26T08:05:24.042Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments: '{"cmd":"pwd"}',
        call_id: 'call_123',
      },
    })
    const tokenCount = JSON.stringify({
      timestamp: '2026-05-26T08:05:25.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        model: 'gpt-5.4',
        info: {
          last_token_usage: {
            input_tokens: 12,
            cached_input_tokens: 0,
            output_tokens: 3,
            reasoning_output_tokens: 0,
          },
        },
      },
    })

    expect(parser.parseLine(functionCall, { ...baseContext, lineOffset: 100 })).toBeNull()
    const result = parser.parseLine(tokenCount, { ...baseContext, lineOffset: 200 })

    expect(result).not.toBeNull()
    expect(result!.toolCalls).toHaveLength(1)
    expect(result!.toolCalls[0].name).toBe('exec_command')
  })
})

/**
 * OpenAI nests its buckets; Anthropic does not. This is the half of that
 * disagreement that has to subtract — see claude-code.test.ts for the half
 * that must not.
 *
 * Measured on real sessions: total_tokens == input_tokens + output_tokens on
 * every row, and never held once cached was subtracted. So cached sits inside
 * input and reasoning inside output. Passing both to calculateCost as
 * separate buckets charged the cached tokens twice and turned about $26 of
 * Codex usage into $198.
 */
describe('CodexParser — buckets that nest', () => {
  const context: ParseContext = {
    sourceFile: 'rollout.jsonl',
    lineOffset: 0,
    sessionId: 'rollout-abc123',
    tool: 'codex',
    now: 1776738085700,
    device: 'test-device',
    deviceInstanceId: 'device-123',
  }

  const tokenCount = (usage: Record<string, number>) => JSON.stringify({
    timestamp: '2026-08-31T00:00:00.000Z',
    type: 'event_msg',
    payload: { type: 'token_count', model: 'gpt-4o', info: { last_token_usage: usage } },
  })

  it('records the input net of the cached part', () => {
    const parser = new CodexParser()
    const result = parser.parseLine(tokenCount({
      input_tokens: 220795,
      cached_input_tokens: 220288,
      output_tokens: 14180,
      reasoning_output_tokens: 7596,
      total_tokens: 234975,
    }), context)

    // 220795 - 220288. The cache is charged once, at the cache rate.
    expect(result?.record.inputTokens).toBe(507)
    expect(result?.record.cacheReadTokens).toBe(220288)
    // Input and cache still add back to what OpenAI reported.
    expect(result!.record.inputTokens + result!.record.cacheReadTokens).toBe(220795)
  })

  it('leaves reasoning out, because output already contains it', () => {
    const parser = new CodexParser()
    const result = parser.parseLine(tokenCount({
      input_tokens: 1000,
      cached_input_tokens: 0,
      output_tokens: 500,
      reasoning_output_tokens: 300,
      total_tokens: 1500,
    }), context)

    expect(result?.record.outputTokens).toBe(500)
    expect(result?.record.thinkingTokens).toBe(0)
  })

  it('charges the cache once instead of twice', () => {
    const parser = new CodexParser()
    const result = parser.parseLine(tokenCount({
      input_tokens: 100000,
      cached_input_tokens: 99000,
      output_tokens: 1000,
      reasoning_output_tokens: 0,
      total_tokens: 101000,
    }), context)

    // gpt-4o here, but the shape is what matters: the 99,000 cached tokens
    // must not appear in both the input bucket and the cache bucket.
    const r = result!.record
    expect(r.inputTokens).toBe(1000)
    expect(r.cacheReadTokens).toBe(99000)
    expect(r.inputTokens + r.cacheReadTokens).toBe(100000)
  })

  /**
   * If cached ever exceeds input, the nesting this all rests on has changed.
   * Clamped so the record stays usable, and warned so it is not silent.
   */
  it('clamps to zero rather than recording a negative input', () => {
    const parser = new CodexParser()
    const result = parser.parseLine(tokenCount({
      input_tokens: 100,
      cached_input_tokens: 500,
      output_tokens: 10,
      reasoning_output_tokens: 0,
      total_tokens: 110,
    }), context)

    expect(result?.record.inputTokens).toBe(0)
    expect(result?.record.cacheReadTokens).toBe(500)
  })

  /**
   * Desktop-app sessions report a total and nothing else. Recorded as 0 for
   * now — wrong but visible — rather than skipped, which is how a format
   * change stays hidden.
   */
  it('still produces a record when only a total is reported', () => {
    const parser = new CodexParser()
    const result = parser.parseLine(tokenCount({
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 4713175,
    }), context)

    expect(result).not.toBeNull()
    expect(result?.record.inputTokens).toBe(0)
    expect(result?.record.outputTokens).toBe(0)
  })
})

/**
 * Desktop sessions report a running total and no split, so one turn's usage
 * is the step between rows. That makes the parser stateful across lines, and
 * stateful-across-lines is where a resume goes wrong: if the previous total
 * were lost, the first row after a restart would be charged the whole
 * session.
 *
 * It is not lost, and this pins down why. The caller replays every line of
 * the file through the parser and throws away the results before the
 * watermark, precisely so fields like this survive. These tests reproduce
 * that replay.
 */
describe('CodexParser — totals with no breakdown', () => {
  const context: ParseContext = {
    sourceFile: 'rollout.jsonl',
    lineOffset: 0,
    sessionId: 'rollout-abc123',
    tool: 'codex',
    now: 1776738085700,
    device: 'test-device',
    deviceInstanceId: 'device-123',
  }

  /** A desktop-app row: a running total, every breakdown field zero. */
  const totalOnly = (cumulative: number) => JSON.stringify({
    timestamp: '2026-08-31T00:00:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      model: 'gpt-4o',
      info: {
        total_token_usage: {
          input_tokens: 0, cached_input_tokens: 0, output_tokens: 0,
          reasoning_output_tokens: 0, total_tokens: cumulative,
        },
        last_token_usage: {
          input_tokens: 0, cached_input_tokens: 0, output_tokens: 0,
          reasoning_output_tokens: 0, total_tokens: cumulative,
        },
      },
    },
  })

  // The real sequence from one session on this machine.
  const SEQUENCE = [3888225, 3893233, 4578008, 4713175]
  const STEPS = [3888225, 5008, 684775, 135167]

  it('charges each row the step since the previous one', () => {
    const parser = new CodexParser()
    const got = SEQUENCE.map((c) => parser.parseLine(totalOnly(c), context)!.record.inputTokens)
    expect(got).toEqual(STEPS)
  })

  it('adds up to the session total rather than several times it', () => {
    const parser = new CodexParser()
    const total = SEQUENCE
      .map((c) => parser.parseLine(totalOnly(c), context)!.record.inputTokens)
      .reduce((a, b) => a + b, 0)
    // Summing the reported values instead would give 17,072,641 — 3.6x.
    expect(total).toBe(4713175)
  })

  it('flags the rows and refuses to price them', () => {
    const parser = new CodexParser()
    const record = parser.parseLine(totalOnly(1000), context)!.record
    expect(record.breakdownMissing).toBe(true)
    expect(record.cost).toBe(0)
    expect(record.costSource).toBe('unknown')
  })

  /**
   * Compaction restarts the counter. Treating the drop as cur - prev would
   * produce a large negative; the new value is the usage since the reset.
   */
  it('treats a drop as a restarted counter, not a negative', () => {
    const parser = new CodexParser()
    parser.parseLine(totalOnly(19592555), context)
    const afterReset = parser.parseLine(totalOnly(169835), context)!.record
    expect(afterReset.inputTokens).toBe(169835)
  })

  /**
   * The resume case. A second parser replays the file from the top and
   * discards what falls before the watermark, exactly as runParse does —
   * and must then charge the same step for the row after it.
   */
  it('charges the same step after a restart as it did in one pass', () => {
    const straightThrough = new CodexParser()
    const expected = SEQUENCE.map((c) => straightThrough.parseLine(totalOnly(c), context)!.record.inputTokens)

    // Restart before the last row: replay the first three, keep only the last.
    const resumed = new CodexParser()
    for (const c of SEQUENCE.slice(0, 3)) resumed.parseLine(totalOnly(c), context)
    const afterResume = resumed.parseLine(totalOnly(SEQUENCE[3]), context)!.record

    expect(afterResume.inputTokens).toBe(expected[3])
    expect(afterResume.inputTokens).toBe(135167)
  })

  /**
   * And the failure this all guards against: a parser that starts at the
   * watermark without the replay bills the whole session to one row.
   */
  it('would bill the whole session to one row without the replay', () => {
    const noReplay = new CodexParser()
    const wrong = noReplay.parseLine(totalOnly(SEQUENCE[3]), context)!.record
    expect(wrong.inputTokens).toBe(4713175)
    expect(wrong.inputTokens).not.toBe(135167)
  })
})
