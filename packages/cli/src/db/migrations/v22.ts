import type Database from 'better-sqlite3'

/**
 * Stop charging Codex's cached tokens twice.
 *
 * OpenAI reports input_tokens including the cached part and output_tokens
 * including the reasoning part; Anthropic does neither. The Codex parser
 * handed both to the cost calculation as separate buckets, so every cached
 * token was billed once at the full input rate and again at the cache rate.
 * With 42.6M of 43.9M input tokens cached, that turned about $26 of usage
 * into $198.
 *
 * The parser now subtracts at capture. This brings the rows already stored
 * into line: input_tokens loses the cached part it should never have carried,
 * and thinking_tokens goes to 0 because output_tokens already contains it.
 * Costs are not touched here — `aiusage recalc` recomputes them from the
 * corrected tokens.
 *
 * Every Codex row is corrected, including rows that arrived from another
 * machine. That is deliberate: mergeSyncedRecordsIntoRecords only ever
 * inserts, so a spoke fixing its own copy can never update the hub's, and
 * leaving those rows alone would leave them wrong forever. There is no path
 * by which they get corrected twice. synced_records is left untouched — it is
 * a holding table, and correcting it would change nothing anyone reads.
 */
export function migrateV22(db: Database.Database): void {
  /*
   * The subtraction is not idempotent, so it must never run on rows that
   * have already had it applied. A row where the cache exceeds the input is
   * the signal that either it ran before or the nesting assumption is wrong;
   * either way, guessing is worse than stopping.
   */
  const suspect = db.prepare(`
    SELECT COUNT(*) AS n FROM records
    WHERE tool = 'codex' AND input_tokens < cache_read_tokens
  `).get() as { n: number }

  if (suspect.n > 0) {
    console.warn(
      `[migration] v22 skipped: ${suspect.n} codex row(s) already have ` +
      'cache_read_tokens above input_tokens, so the correction has either ' +
      'run already or no longer applies. Nothing changed.')
    db.prepare('INSERT INTO schema_version (version) VALUES (22)').run()
    return
  }

  const result = db.prepare(`
    UPDATE records
    SET input_tokens = input_tokens - cache_read_tokens,
        thinking_tokens = 0,
        updated_at = ?
    WHERE tool = 'codex'
      AND (cache_read_tokens > 0 OR thinking_tokens > 0)
  `).run(Date.now())

  if (result.changes > 0) {
    console.log(
      `[migration] v22 corrected ${result.changes} codex row(s): the cached ` +
      'tokens were being counted in input as well as in the cache bucket. ' +
      'Run `aiusage recalc` to bring the costs into line.')
  }

  db.prepare('INSERT INTO schema_version (version) VALUES (22)').run()
}
