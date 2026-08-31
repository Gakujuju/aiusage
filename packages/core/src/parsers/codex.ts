import type { Parser, ParseResult, ParseContext } from '../types.js'
import type { StatsRecord, ToolCallRecord, Tool } from '../types.js'
import { generateRecordId, generateToolCallId, generateOrphanToolCallId } from '../record-id.js'
import { inferProvider } from '../provider.js'
import { calculateCost, resolvePrice } from '../pricing.js'

interface PendingToolCall {
  name: string
  ts: number
}

/** Said once per process: a per-line warning would be one per turn. */
const warned = new Set<string>()
function warnOnce(message: string): void {
  if (warned.has(message)) return
  warned.add(message)
  console.warn('[parse] ' + message)
}

export class CodexParser implements Parser {
  readonly tool: Tool = 'codex'
  private pendingToolCalls: PendingToolCall[] = []
  private currentModel: string | null = null
  /**
   * The session's running token total as of the last row seen.
   *
   * Only meaningful within one file, and rebuilt from the top on every parse
   * because the caller replays the whole file through the parser before the
   * watermark. A fresh parser per file keeps sessions from bleeding together.
   */
  private lastCumulative = 0

  parseLine(line: string, context: ParseContext): ParseResult | null {
    let parsed: any
    try {
      parsed = JSON.parse(line)
    } catch {
      return null
    }

    // Support multiple formats:
    //   { event_msg: { payload: ... } }        — oldest wrapped format
    //   { type: 'event_msg', payload: ... }     — unwrapped event_msg
    //   { type: 'response_item', payload: ... } — newer format (function_call lives here)
    const payload = parsed.event_msg?.payload
      ?? (parsed.type === 'event_msg' || parsed.type === 'response_item' ? parsed.payload : undefined)

    // Track model from turn_context events (top-level or wrapped)
    const turnCtx = parsed.type === 'turn_context' ? parsed.payload : undefined
    if (turnCtx?.model) {
      this.currentModel = turnCtx.model
    }
    if (payload?.type === 'turn_context' && payload.model) {
      this.currentModel = payload.model
    }

    if (!payload) return null

    // Skip non-token_count/function_call lines
    if (payload.type !== 'token_count' && payload.type !== 'function_call') return null

    // Store function_call as pending
    if (payload.type === 'function_call') {
      const rawFcTs = parsed.event_msg?.timestamp ?? parsed.timestamp ?? context.now
      this.pendingToolCalls.push({
        // newer format: payload.name; older format: payload.function.name
        name: payload.name ?? payload.function?.name ?? 'unknown',
        ts: typeof rawFcTs === 'number' ? rawFcTs : new Date(rawFcTs).getTime(),
      })
      return null
    }

    // Process token_count — support both old format (payload.last_token_usage) and new format (payload.info.last_token_usage)
    const usage = payload.last_token_usage ?? payload.info?.last_token_usage
    if (!usage) {
      return null
    }

    /*
     * The cumulative counter, tracked on every row of either shape.
     *
     * Codex reports a running total per session. The desktop app reports
     * *only* that — every breakdown field 0 — so the usage of one turn has to
     * come from the step between rows.
     *
     * Rebuilt from the start of the file on every parse: the caller replays
     * every line through the parser and discards the results before the
     * watermark, precisely so stateful fields like this one survive a resume.
     * Without that, the first row after a restart would be charged the whole
     * session.
     */
    const cumulative = payload.info?.total_token_usage?.total_tokens
    const breakdownMissing =
      (usage.total_tokens ?? 0) > 0
      && (usage.input_tokens ?? 0) === 0
      && (usage.output_tokens ?? 0) === 0

    let totalOnlyTokens = 0
    if (typeof cumulative === 'number') {
      /*
       * A drop means the session was compacted and the counter restarted, so
       * the new value is the usage since the reset rather than a decrease.
       * Treating it as cur - prev would produce a large negative.
       */
      totalOnlyTokens = cumulative < this.lastCumulative
        ? cumulative
        : cumulative - this.lastCumulative
      this.lastCumulative = cumulative
    }

    if (breakdownMissing) {
      warnOnce(
        'codex: token_count reports a total but no input/output split ' +
        '(desktop-app sessions do this). The total is recorded as input and ' +
        'the row is flagged; cost cannot be computed from it.')
    }

    const model = payload.model ?? parsed.model ?? this.currentModel ?? 'unknown'
    const rawTs = parsed.event_msg?.timestamp ?? parsed.timestamp ?? context.now
    const ts = typeof rawTs === 'number' ? rawTs : new Date(rawTs).getTime()

    /*
     * OpenAI reports input_tokens *including* the cached part, and
     * output_tokens *including* the reasoning part. Anthropic does neither,
     * which is why this parser and claude-code's differ here.
     *
     * Measured on this machine: total_tokens == input_tokens + output_tokens
     * held on every row of every session, and never held once cached was
     * subtracted — so cached is inside input, and reasoning is inside output.
     * Handing both to calculateCost as separate buckets charged the cached
     * tokens twice, once at the full input rate and again at the cache rate.
     * With 42.6M of 43.9M input tokens cached, that inflated Codex from
     * about $26 to $198.
     *
     * The subtraction happens here rather than in calculateCost so that
     * "input" means the same thing for every tool — the dashboard shows
     * input and cache read as separate columns, and they have to add up.
     */
    const rawInput = usage.input_tokens ?? 0
    const cacheReadTokens = usage.cached_input_tokens ?? 0
    const outputTokens = usage.output_tokens ?? 0

    /*
     * A negative result would mean cached is no longer inside input — the
     * premise above having changed under us. Clamp so the record stays
     * usable, but say so: silently recording 0 is how the previous version of
     * this went unnoticed for months.
     */
    /*
     * With no split available, the whole step goes into inputTokens so the
     * token count is right, and breakdownMissing says that "input" here is
     * really input+output. Losing the number entirely was the alternative,
     * and that is what hid 7.6M tokens.
     */
    const inputTokens = breakdownMissing
      ? totalOnlyTokens
      : Math.max(0, rawInput - cacheReadTokens)
    if (rawInput - cacheReadTokens < 0) warnOnce(
      'codex: cached_input_tokens exceeds input_tokens — the breakdown no longer ' +
      'nests the way the cost calculation assumes. Input clamped to 0.')

    /*
     * Already inside output_tokens, so it is charged there. Passing it as
     * well would bill the reasoning a second time at the output rate.
     */
    const thinkingTokens = 0

    /*
     * The field exists — cache_write_input_tokens — but was 0 on all 449
     * token_count rows observed. Left at 0 rather than read, so that a real
     * value showing up later is a deliberate change rather than a silent one.
     */
    const cacheWriteTokens = 0

    // No split, no cost: the rates differ per bucket, so a price computed
    // from a lump sum would be a guess wearing a number's clothes.
    const cost = (model === 'unknown' || breakdownMissing) ? 0 : calculateCost(model, {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      thinkingTokens,
    }, context.exchangeRate)

    // Whether a price was actually found, not merely whether the model was
    // named. Reporting 'pricing' for a model missing from the table is what
    // let a total of $0 read as "no usage" rather than "no prices", for months.
    /*
     * 'unknown' whenever no cost was actually computed, not merely when the
     * model is unpriced. A total-only row has a price for its model and still
     * cannot be costed, and reporting 'pricing' beside a 0 is precisely the
     * combination that had this project reading "$0" as "unused" for months
     * (D15).
     */
    const costSource = (breakdownMissing || resolvePrice(model) == null)
      ? 'unknown' as const
      : 'pricing' as const
    const provider = inferProvider(model)

    const recordId = generateRecordId(context.deviceInstanceId, context.sourceFile, context.lineOffset)

    const record: StatsRecord = {
      id: recordId,
      ts,
      ingestedAt: context.now,
      updatedAt: context.now,
      lineOffset: context.lineOffset,
      tool: this.tool,
      model,
      provider,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      thinkingTokens,
      cost,
      costSource,
      sessionId: context.sessionId,
      sourceFile: context.sourceFile,
      device: context.device,
      deviceInstanceId: context.deviceInstanceId,
      platform: context.platform,
      breakdownMissing,
    }

    // Associate pending tool calls
    const toolCalls: ToolCallRecord[] = this.pendingToolCalls.map((tc, callIndex) => ({
      id: generateToolCallId(recordId, tc.name, tc.ts, callIndex),
      recordId,
      name: tc.name,
      ts: tc.ts,
      callIndex,
    }))

    // Clear pending queue
    this.pendingToolCalls = []

    return { record, toolCalls }
  }

  finalize(): ParseResult[] {
    // Handle orphan tool calls (no subsequent token_count)
    if (this.pendingToolCalls.length === 0) return []

    const toolCalls: ToolCallRecord[] = this.pendingToolCalls.map((tc, callIndex) => ({
      id: generateOrphanToolCallId(this.tool, tc.name, tc.ts, callIndex),
      recordId: null,
      name: tc.name,
      ts: tc.ts,
      callIndex,
    }))

    this.pendingToolCalls = []

    return [{ record: null, toolCalls }]
  }
}
