import type Database from 'better-sqlite3'
import { resolveExchangeRate } from '@aiusage/core'
import { loadConfig } from '../config.js'
import { hasUserPrice } from '../pricing-registry.js'
import {
  decideRecalc,
  makePriceResolver,
  RECALC_COLUMNS,
  RECALC_UPDATE_SQL,
  type RecalcRow,
} from '../pricing/recalc-row.js'

export interface RecalcResult {
  updatedCount: number
  skippedCount: number
}

const BATCH_SIZE = 1000

/**
 * Reprice every row from the current price table.
 *
 * What to do with a row lives in decideRecalc, shared with the dashboard's
 * recalc button. Both copies of that decision had the same defect once and
 * it had to be found twice; only the loop differs now, and it differs for a
 * reason — this one runs to completion in a short-lived command, while the
 * API's has to let the server answer requests in between.
 */
export function recalcPricing(db: Database.Database): RecalcResult {
  let updatedCount = 0
  let skippedCount = 0
  let lastId = ''

  const deps = {
    resolvePrice: makePriceResolver(db),
    hasUserPrice: (model: string) => hasUserPrice(db, model),
    exchangeRate: resolveExchangeRate(loadConfig() ?? {}),
  }

  const selectStmt = db.prepare(
    `SELECT ${RECALC_COLUMNS} FROM records WHERE id > ? ORDER BY id LIMIT ?`)
  const updateStmt = db.prepare(RECALC_UPDATE_SQL)

  /*
   * A batch at a time, in a transaction.
   *
   * Without one, a run interrupted part way leaves the table half repriced
   * with nothing to say so — some rows at the new price, some at the old,
   * and no marker anywhere. Several of today's faults were exactly that
   * shape, and there is no reason to keep making new ones.
   */
  const applyBatch = db.transaction((rows: RecalcRow[]) => {
    for (const row of rows) {
      const decision = decideRecalc(row, deps)
      if (decision.action === 'skip') { skippedCount++; continue }
      if (decision.action === 'keep') continue
      updateStmt.run(
        decision.model, decision.provider, decision.cost, decision.costSource,
        Date.now(), row.id)
      updatedCount++
    }
  })

  while (true) {
    const rows = selectStmt.all(lastId, BATCH_SIZE) as RecalcRow[]
    if (rows.length === 0) break
    applyBatch(rows)
    lastId = rows[rows.length - 1].id
  }

  return { updatedCount, skippedCount }
}
