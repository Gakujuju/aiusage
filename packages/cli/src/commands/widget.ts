import { existsSync, readFileSync } from 'node:fs'
import { spawn, execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AIUSAGE_DIR } from '../config.js'

const WIDGET_PID_PATH = join(AIUSAGE_DIR, 'widget.pid')

export async function launchWidget(): Promise<void> {
  if (isWidgetRunning()) {
    console.log('aiusage widget is already running in the system tray.')
    return
  }

  const target = resolveWidget()

  if (target.kind === 'nothing') {
    console.error('Widget not installed. Run: npm install -g @juliantanx/aiusage-widget')
    process.exit(1)
  }

  if (target.kind === 'unbuilt') {
    /*
     * Deliberately not offering the published package here.
     *
     * Standing in a checkout of this repository, the answer to "the widget
     * will not start" is to build the one in front of you. Installing the
     * global one launches a different program that happens to share a name -
     * which is how someone spent an afternoon looking at a window that had
     * none of the day's changes in it.
     */
    console.error(`Widget not built at ${target.appDir}`)
    console.error('Run: pnpm --filter @juliantanx/aiusage-widget build')
    process.exit(1)
  }

  /*
   * Which one, out loud.
   *
   * The global package and the one in this checkout are different programs.
   * Choosing between them silently is the whole of the problem this solves.
   */
  const child = target.kind === 'workspace'
    ? spawn(target.electron, [target.appDir], { detached: true, stdio: 'ignore', shell: false })
    : spawnInstalled(target.command)
  child.unref()

  console.log(target.kind === 'workspace'
    ? `aiusage widget started from this checkout: ${target.appDir}`
    : `aiusage widget started from the installed package: ${target.command}`)
}

function isWidgetRunning(): boolean {
  if (!existsSync(WIDGET_PID_PATH)) return false

  let pid: number
  try {
    pid = parseInt(readFileSync(WIDGET_PID_PATH, 'utf-8').trim(), 10)
  } catch {
    return false
  }

  if (isNaN(pid)) return false

  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err.code !== 'ESRCH'
  }
}

type WidgetTarget =
  | { kind: 'installed'; command: string }
  | { kind: 'workspace'; appDir: string; electron: string }
  | { kind: 'unbuilt'; appDir: string }
  | { kind: 'nothing' }

/**
 * The widget to start, and where it came from.
 *
 * This tree first, then PATH. Not a guess about intent - the CLI and the
 * widget are two halves of one build, and running the CLI from a checkout
 * while the widget comes from a global install mixes two versions of the
 * same program.
 *
 * The rule keeps itself honest because findWorkspaceWidget walks up from
 * this file: it can only ever find the tree the running CLI came out of. A
 * globally installed CLI finds nothing there and falls through to PATH,
 * which is the right answer for it.
 */
function resolveWidget(): WidgetTarget {
  const appDir = findWorkspaceWidget()
  if (appDir) {
    if (!existsSync(join(appDir, 'dist', 'main.js'))) return { kind: 'unbuilt', appDir }
    const electron = resolveElectron(appDir)
    if (electron) return { kind: 'workspace', appDir, electron }
    return { kind: 'unbuilt', appDir }
  }

  const installed = commandOnPath('aiusage-widget')
  if (installed) return { kind: 'installed', command: installed }

  return { kind: 'nothing' }
}

/**
 * Starts a command that npm put on PATH, which on Windows is a batch file.
 *
 * `aiusage-widget` resolves to `aiusage-widget.cmd`, and spawning a .cmd
 * without a shell fails with EINVAL - Node closed that door deliberately.
 * This branch has therefore never worked on Windows; it only came to light
 * once there was a second branch to compare it against.
 *
 * cmd.exe is invoked directly rather than via `shell: true` so the path is
 * an argument rather than something the shell parses. It comes from `where`
 * and so contains whatever the user's directories are called.
 */
function spawnInstalled(command: string) {
  const options = { detached: true, stdio: 'ignore' as const, shell: false }
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    /*
     * Quoted here and passed through verbatim, because the path usually has
     * a space in it - `where` returns the long form, and a home directory of
     * two words is ordinary. Letting Node quote it for cmd.exe produces
     * something cmd splits on the space and cannot find.
     *
     * Without /s, deliberately. /s tells cmd to strip the outer quotes and
     * take the rest literally, which is the opposite of what is wanted when
     * the quotes are the only thing holding the path together: measured, a
     * spaced path runs with /d /c and silently does not with /d /s /c.
     */
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `"${command}"`], {
      ...options,
      windowsVerbatimArguments: true,
    })
  }
  return spawn(command, [], options)
}

function commandOnPath(name: string): string | null {
  try {
    const found = execSync(
      process.platform === 'win32' ? `where ${name}` : `which ${name}`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim()
    /* `where` prints every match, one per line. The first is what would run. */
    return found.split(/\r?\n/)[0] || null
  } catch {
    return null
  }
}

/**
 * Walks up from this file looking for the widget package in the same tree.
 *
 * Walking rather than counting `..` segments, because this file runs from
 * two different depths - src/commands under tsx, dist under a build - and a
 * fixed number of parents is right for exactly one of them.
 */
function findWorkspaceWidget(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let up = 0; up < 6; up++) {
    const candidate = join(dir, 'packages', 'widget')
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * The electron binary that package would use, asked for the way it would.
 *
 * `require('electron')` returns the path to the executable. Resolving it
 * from the widget's own package.json means pnpm's layout is pnpm's problem
 * rather than a path guessed from here.
 */
function resolveElectron(appDir: string): string | null {
  try {
    const bin = createRequire(join(appDir, 'package.json'))('electron')
    return typeof bin === 'string' && existsSync(bin) ? bin : null
  } catch {
    return null
  }
}
