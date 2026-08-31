/**
 * The conditions that decide which rows a figure is made of.
 *
 * These were written out by hand wherever they were needed, and three
 * separate copies were wrong in three separate ways on the same day:
 *
 *   - /api/summary counted every merged row twice, because the test for
 *     "this machine produced it" guessed from a file path;
 *   - `aiusage summary` had the same false test and was still counting
 *     twice for hours after the API was fixed, so the status line and the
 *     dashboard disagreed by a tenth;
 *   - the leaderboard upload needed its own exclusion for rows with no
 *     token breakdown, and grew a third spelling of it.
 *
 * What went wrong each time was the *predicate*, not the query around it,
 * so the predicate is what is shared. They are exported as named ideas
 * rather than SQL because the string itself is what lied: reading
 * `AND source_file NOT LIKE 'synced/%'` at a call site tells you nothing
 * about whether it is true, and it was not.
 *
 * Every one of these is a fragment meant to sit in a WHERE clause, and each
 * names the table it talks about, so a query that aliases its tables needs
 * the aliased variants below.
 */

/**
 * Rows this machine produced, as opposed to rows that arrived from a spoke.
 *
 * Asks whether the row also exists in synced_records, which is the actual
 * question. The old version tested the source_file for a 'synced/' prefix
 * that the merge only invents for rows arriving without a path of their
 * own — which direct sync never sends — so it matched almost nothing it
 * was meant to match.
 *
 * For single-table queries. A union deduplicates on the other side instead:
 * filtering both halves drops a merged row from each of them and counts it
 * zero times.
 */
export const PRODUCED_HERE = 'AND NOT EXISTS (SELECT 1 FROM synced_records s WHERE s.id = records.id)'

/** PRODUCED_HERE for a query that has aliased records to r. */
export const PRODUCED_HERE_R = 'AND NOT EXISTS (SELECT 1 FROM synced_records s WHERE s.id = r.id)'

/**
 * Rows the merge has not copied into records yet.
 *
 * The synced side of a union takes only these, so a row that exists in both
 * tables is counted once — from records, which is the copy this machine
 * corrects and the one the merge keeps current.
 *
 * Not simply dropping the synced side: the merge only runs when a spoke
 * uploads, so a freshly arrived row lives in synced_records alone until
 * then. Measured on the hub at 18.7 minutes on average, 19.7 at worst, with
 * 314 rows observed waiting.
 */
export const NOT_YET_MERGED = 'AND NOT EXISTS (SELECT 1 FROM records r WHERE r.id = synced_records.id)'

/**
 * Rows whose logs gave a lump total with no input/output split.
 *
 * They are recorded at cost 0 with cost_source 'unknown' on purpose, and
 * their whole total sits in input_tokens because that is where a lump sum
 * lands. Exclude them from anything that presents a token *split* or a
 * price — including anything published outside this machine, where a wrong
 * split cannot be corrected later.
 *
 * Do not exclude them from a count of what is uncosted: they are uncosted
 * for a reason nobody can fix, and saying so is a different statement from
 * "you are missing a price". Conflating the two put a warning on the home
 * screen naming a model that already had one.
 */
export const HAS_TOKEN_BREAKDOWN = 'AND breakdown_missing = 0'
