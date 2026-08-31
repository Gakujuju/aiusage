import type Database from 'better-sqlite3'
import type { PriceEntry } from '@aiusage/core'
import { calculateCostForPrice, inferProvider, normalizeQoderModel } from '@aiusage/core'
import { resolvePriceFromRegistry } from '../pricing-registry.js'

/**
 * What recalculating one row decides, in one place.
 *
 * There are two callers and there will go on being two: the CLI walks the
 * table straight through, while the API has to yield the event loop between
 * batches so the dashboard keeps answering while twenty thousand rows are
 * repriced. Those loops differ for a reason and stay apart.
 *
 * The decision does not. It was written out twice, and both copies had the
 * same defect — pricing rows whose logs gave no token split, inventing
 * $28.70 across 24 rows — which had to be found and fixed twice. They had
 * also quietly drifted: only one of them kept the original model name when
 * normalisation could not identify it, so the same row could come out
 * differently depending on which button you pressed.
 *
 * Everything that was ever wrong here is in this function.
 */

/** The columns a decision needs. Both callers select exactly these. */
export interface RecalcRow {
  id: string
  tool: string
  model: string
  provider: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  thinking_tokens: number
  cost: number
  cost_source: string
  breakdown_missing: number
}

export type RecalcDecision =
  /** A logged cost the tool reported itself, which outranks any price table. */
  | { action: 'skip' }
  /** Already correct; writing it back would only move updated_at. */
  | { action: 'keep' }
  | { action: 'update'; model: string; provider: string; cost: number; costSource: string }

export interface RecalcDeps {
  resolvePrice: (model: string) => PriceEntry | undefined
  hasUserPrice: (model: string) => boolean
  exchangeRate: number
}

/**
 * A price lookup that remembers what it has already been asked.
 *
 * Every row of a tool tends to name the same handful of models, and the
 * registry lookup is a query. The CLI did without this and paid for it on
 * every row.
 */
export function makePriceResolver(db: Database.Database): (model: string) => PriceEntry | undefined {
  const cache = new Map<string, PriceEntry | null>()
  return (model: string) => {
    if (cache.has(model)) return cache.get(model) ?? undefined
    const price = resolvePriceFromRegistry(db, model) ?? null
    cache.set(model, price)
    return price ?? undefined
  }
}

export function decideRecalc(row: RecalcRow, deps: RecalcDeps): RecalcDecision {
  /*
   * Normalising must not lose the name it started with.
   *
   * normalizeQoderModel answers 'unknown' when it cannot identify a model,
   * and writing that back replaces a real name with a value this codebase
   * has already had to clean up after — backfillCodexModels exists to repair
   * rows whose model is 'unknown'. Keep what the log said instead.
   */
  const normalized = row.tool === 'qoder' ? normalizeQoderModel(row.model) : row.model
  const model = normalized === 'unknown'
    ? (row.tool === 'qoder' ? 'qoder-auto' : row.model)
    : normalized

  /*
   * A cost the tool reported is authoritative and left alone — except when
   * it is non-positive, which is what custom gateways report for models they
   * do not price, or when the reader has set a price for this model by hand.
   * In either case the logged value must not block repricing (issue #13).
   */
  if (row.cost_source === 'log' && row.cost > 0 && !deps.hasUserPrice(model)) {
    return { action: 'skip' }
  }

  const provider = model !== row.model ? inferProvider(model) : row.provider
  const price = deps.resolvePrice(model)

  /*
   * A row with no input/output split cannot be priced. Its whole token count
   * sits in input_tokens because that is the only way to count it at all, so
   * multiplying it by the input rate invents a number. The parser already
   * refuses to price these; recalc has to refuse too, or the button on the
   * dashboard quietly undoes it.
   */
  const priceable = price != null && !row.breakdown_missing
  const cost = priceable
    ? calculateCostForPrice(price, {
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        thinkingTokens: row.thinking_tokens,
      }, deps.exchangeRate)
    : 0
  const costSource = priceable ? 'pricing' : 'unknown'

  if (model === row.model && provider === row.provider
      && cost === row.cost && costSource === row.cost_source) {
    return { action: 'keep' }
  }
  return { action: 'update', model, provider, cost, costSource }
}

/** The columns both callers read, kept here so they cannot drift apart. */
export const RECALC_COLUMNS =
  'id, tool, model, provider, input_tokens, output_tokens, cache_read_tokens, '
  + 'cache_write_tokens, thinking_tokens, cost, cost_source, breakdown_missing'

export const RECALC_UPDATE_SQL =
  'UPDATE records SET model = ?, provider = ?, cost = ?, cost_source = ?, updated_at = ? WHERE id = ?'
