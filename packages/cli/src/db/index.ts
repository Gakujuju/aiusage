import Database from 'better-sqlite3'
import { mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { applyPragmas } from './schema.js'
import { runMigrations, EXPECTED_SCHEMA_VERSION, currentSchemaVersion } from './migrations/index.js'
import { existsSync } from 'node:fs'
import { loadConfig } from '../config.js'
import { loadPricingRuntime } from '../pricing-registry.js'

export function initializeDatabase(db: Database.Database): void {
  applyPragmas(db)
  runMigrations(db)
  loadPricingRuntime(db, loadConfig())
}

function removeCorruptedDb(path: string): void {
  for (const suffix of ['', '-shm', '-wal']) {
    try { unlinkSync(path + suffix) } catch {}
  }
}

/**
 * Open the database and bring the schema up to date, creating both if they
 * are not there yet.
 *
 * **Only serve and init may call this.** Everything else uses
 * openWithoutMigrating below.
 *
 * Three of today's four production accidents came through this function
 * being the only way to open the database. A status line running `aiusage`
 * every few seconds, a preview server, and a `node -e` poking at the bundle
 * all migrated the real installation because opening it was the same act as
 * upgrading it. Nothing about reading a summary requires the authority to
 * rewrite the schema.
 */
export function createDatabase(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    const db = new Database(path)
    initializeDatabase(db)
    return db
  } catch (err: unknown) {
    const code = (err as { code?: string }).code
    if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB') {
      console.warn(`Database corrupted, recreating: ${path}`)
      removeCorruptedDb(path)
      const db = new Database(path)
      initializeDatabase(db)
      return db
    }
    throw err
  }
}

/**
 * How a command that is not serve or init should open the database.
 *
 * Reads the schema, never writes it. Three separate accidents this month
 * were short-lived processes upgrading the production database as a side
 * effect of looking at it, and there is no version of "show me a summary"
 * that needs to change a schema.
 *
 * The database has to exist. Creating one on demand is what let a mistyped
 * AIUSAGE_HOME, a preview server and a status line each leave a database
 * somewhere nobody meant to put one — the file appearing is the first sign
 * that the wrong thing was opened, and it appeared silently.
 *
 * An older schema is refused rather than upgraded. Reading v22 code against
 * a v20 file gives missing columns and silent zeros, which is the failure
 * that is hardest to notice — today's breakdown_missing rows were exactly
 * that shape. A newer one is allowed with a warning: the columns this build
 * knows about are still there.
 */
export function openWithoutMigrating(
  path: string,
  options: { quiet?: boolean } = {},
): Database.Database | null {
  if (!existsSync(path)) {
    if (!options.quiet) {
      console.error(`No database at ${path}.`)
      // serve, not init: init writes the config file, while serve is what
      // creates the database and brings the schema up to date.
      console.error('Start `aiusage serve` to create one.')
    }
    return null
  }

  const db = new Database(path)
  applyPragmas(db)

  const version = currentSchemaVersion(db)
  if (version < EXPECTED_SCHEMA_VERSION) {
    db.close()
    if (!options.quiet) {
      console.error(
        `This database is at schema v${version}; this build expects v${EXPECTED_SCHEMA_VERSION}.`)
      console.error('Start `aiusage serve` to bring it up to date.')
    }
    return null
  }
  if (version > EXPECTED_SCHEMA_VERSION) {
    // Forwards is survivable: every column this build reads still exists.
    console.warn(
      `[db] this database is at schema v${version}, newer than this build (v${EXPECTED_SCHEMA_VERSION}).`)
  }

  loadPricingRuntime(db, loadConfig())
  return db
}
