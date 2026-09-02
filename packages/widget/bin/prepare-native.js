#!/usr/bin/env node
/**
 * Put a better-sqlite3 binding matching Electron's ABI at dist/native, for
 * the build to ship and main.ts to load via `nativeBinding`.
 *
 * This used to call @electron/rebuild on the shared better-sqlite3 in the
 * workspace, which recompiles it in place for Electron's ABI - and the CLI in
 * the same workspace loads that very file expecting Node's. Building the
 * widget therefore broke `aiusage serve`, on the machine it was built on,
 * until someone noticed the data had stopped arriving. It happened.
 *
 * There was a restore step afterwards, `npm run install` in better-sqlite3's
 * directory, and on Windows it threw ENOENT before doing anything: npm is
 * npm.cmd there and execFileSync does not go looking. So the shared binding
 * was left broken every time.
 *
 * The postinstall script next door had already solved this the other way -
 * fetch the Electron-ABI prebuilt into a throwaway directory and copy just
 * the .node out - and never touches the shared install at all. This now does
 * the same. Two scripts, one problem, and only one of them was safe.
 *
 * @electron/rebuild is still available as `pnpm run rebuild:electron` for
 * anyone who needs a compile rather than a download. It is no longer
 * something that happens to you while building the widget.
 */
const {
  copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} = require('node:fs')
const { dirname, join } = require('node:path')
const { execFileSync } = require('node:child_process')
const { tmpdir } = require('node:os')

const widgetRoot = join(__dirname, '..')
const nativeDir = join(widgetRoot, 'dist', 'native')
const nativeTarget = join(nativeDir, 'better_sqlite3.node')
/**
 * What the binding sitting there was built for.
 *
 * The old check compared the mtime of this file against the mtime of the
 * shared better-sqlite3 binary - two different artifacts, whose timestamps
 * come from whenever their upstream tarballs happened to be packed. On this
 * machine they are three minutes apart and in the lucky order. Worse, any
 * run of @electron/rebuild gave the shared file a current mtime, so the
 * check then answered "stale" for ever and rebuilt on every single build.
 *
 * A binding is fresh when it was built for the Electron and platform in use.
 * That is a fact about the file, and it is what this records.
 */
const stampPath = join(nativeDir, 'built-for.json')

function electronVersion() {
  return require('electron/package.json').version
}

function currentStamp() {
  return {
    electron: electronVersion(),
    platform: process.platform,
    arch: process.arch,
  }
}

function isTargetFresh() {
  try {
    if (!existsSync(nativeTarget) || !existsSync(stampPath)) return false
    const was = JSON.parse(readFileSync(stampPath, 'utf8'))
    const now = currentStamp()
    return was.electron === now.electron
      && was.platform === now.platform
      && was.arch === now.arch
  } catch {
    return false
  }
}

function betterSqlite3Dir() {
  return dirname(require.resolve('better-sqlite3/package.json'))
}

/**
 * Fetches the Electron-ABI prebuilt without disturbing the shared install.
 *
 * prebuild-install writes into the current directory, so it is pointed at a
 * copy of better-sqlite3's package.json in a temporary directory. It reads
 * the name and version from there and nothing else, which is the whole trick.
 */
function fetchIntoStage() {
  const pkgPath = require.resolve('better-sqlite3/package.json')
  const prebuildInstall = require.resolve('prebuild-install/bin.js', { paths: [betterSqlite3Dir()] })
  const stageDir = join(tmpdir(), `aiusage-widget-native-${process.pid}`)

  try {
    mkdirSync(stageDir, { recursive: true })
    writeFileSync(join(stageDir, 'package.json'), readFileSync(pkgPath))

    execFileSync(
      process.execPath,
      [
        prebuildInstall,
        '--runtime=electron',
        `--target=${electronVersion()}`,
        `--arch=${process.arch}`,
        `--platform=${process.platform}`,
      ],
      { cwd: stageDir, stdio: 'inherit' },
    )

    const built = join(stageDir, 'build', 'Release', 'better_sqlite3.node')
    if (!existsSync(built)) throw new Error('prebuild-install produced no binary')

    mkdirSync(nativeDir, { recursive: true })
    try {
      copyFileSync(built, nativeTarget)
    } catch (error) {
      /*
       * Windows will not overwrite a .node a running process has loaded, and
       * the process in question is almost always the widget itself - the
       * thing being rebuilt. The raw EBUSY names a temp path and a copy, and
       * says nothing about what to do.
       */
      if (error && error.code === 'EBUSY') {
        throw new Error('the widget is running and holding dist/native/better_sqlite3.node; quit it from the tray and build again')
      }
      throw error
    }
    writeFileSync(stampPath, `${JSON.stringify(currentStamp(), null, 2)}\n`)
  } finally {
    try {
      rmSync(stageDir, { recursive: true, force: true })
    } catch {
      // Cleanup of a temp directory is not worth failing a build over.
    }
  }
}

/**
 * Checks that the CLI's own binding still loads, and repairs it if not.
 *
 * Nothing here breaks it any more, but a machine that ran the old version of
 * this script is still broken, and the person who runs into that is the one
 * building the widget. So: ask a fresh Node process to load better-sqlite3,
 * and if it cannot, fetch the Node-ABI prebuilt back into place.
 *
 * prebuild-install rather than `npm run install`, because npm on Windows is
 * npm.cmd and execFileSync will not find it - the exact failure that left
 * machines broken. process.execPath is a real executable everywhere.
 */
function repairSharedBindingIfBroken() {
  const dir = betterSqlite3Dir()
  try {
    /*
     * Opening a database, not merely requiring the module.
     *
     * better-sqlite3 loads its .node lazily on the first Database, so a bare
     * require succeeds against a binding compiled for the wrong ABI and
     * proves nothing - measured, not assumed. The directory is passed as an
     * argument so this is the shared copy and not some other resolution of
     * the same name.
     */
    execFileSync(
      process.execPath,
      ['-e', 'new (require(process.argv[1]))(":memory:").close()', dir],
      { stdio: 'pipe' },
    )
    return
  } catch {
    // Fall through and repair.
  }

  console.warn('[aiusage-widget] the shared better-sqlite3 binding does not load; restoring the Node build.')
  try {
    const prebuildInstall = require.resolve('prebuild-install/bin.js', { paths: [dir] })
    execFileSync(
      process.execPath,
      [prebuildInstall, '--runtime=node', `--target=${process.versions.node}`, '--force'],
      { cwd: dir, stdio: 'inherit' },
    )
    console.warn('[aiusage-widget] restored. If aiusage serve was running, restart it.')
  } catch (error) {
    console.error('[aiusage-widget] could not restore it automatically.')
    console.error('[aiusage-widget] run this by hand, then restart aiusage serve:')
    console.error(`[aiusage-widget]   cd "${dir}" && npm run install`)
    throw error
  }
}

function main() {
  if (isTargetFresh() && !process.argv.includes('--force')) {
    console.log('Native binding is up to date, skipping (use --force to override)')
  } else {
    fetchIntoStage()

    if (process.platform === 'darwin') {
      // Ad-hoc sign so Gatekeeper will load it.
      execFileSync('codesign', ['--force', '--sign', '-', nativeTarget], { stdio: 'inherit' })
    }

    console.log(`Native binding ready for electron ${electronVersion()} (${process.platform}-${process.arch}).`)
  }

  repairSharedBindingIfBroken()
}

main()
