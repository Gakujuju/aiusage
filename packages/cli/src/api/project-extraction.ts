import path from 'node:path'

// Workspace root directories that sit between the home dir and the actual project.
// The first path segment that is NOT in this set is treated as the project name.
/** `C:`, `D:` — a volume, not a project. */
const DRIVE_LETTER = /^[A-Za-z]:$/

const CWD_WORKSPACE_ROOTS = new Set([
  'WebstormProjects', 'Documents', 'Projects', 'workspace', 'Workspace',
  'dev', 'code', 'repos', 'Developer', 'src',
])

/**
 * Extract a project name from a full working-directory path.
 * Strips the home-directory prefix and any well-known workspace root directories,
 * then returns the first meaningful path segment as the project name.
 *
 * Examples:
 *   /Users/alice/WebstormProjects/my-project          → my-project
 *   /Users/alice/WebstormProjects/my-project/pkg/cli  → my-project
 *   /Users/alice/Documents/org-name/course/homework   → org-name
 *   /Users/alice/Documents/AppName/notes              → AppName
 */
export function extractProjectFromCwd(cwd: string, extraRoots?: string[]): string {
  if (!cwd) return 'unknown'
  const normalized = cwd.replace(/\\/g, '/')
  // Strip home-dir prefix: /Users/<name>/, /home/<name>/, /root/, C:/Users/<name>/
  //
  // The trailing separator is optional because the home directory itself is
  // not a project either. Requiring it meant a cwd of exactly C:\Users\alice
  // matched nothing and was reported as the project "Users" — same mistake as
  // the drive letter below, inventing a project that does not exist. With it
  // optional the whole path is consumed and there is nothing left to name.
  const withoutHome = normalized
    .replace(/^[A-Za-z]:\/(?:Users|home)\/[^/]+(?:\/|$)/, '')
    .replace(/^\/(Users|home)\/[^/]+(?:\/|$)/, '')
    .replace(/^\/root(?:\/|$)/, '')
  // A drive letter is never a project. It survives the home strip whenever the
  // path is not under the home directory, and C:\work\myproj was reported as
  // the project "C:". Dropped here rather than inside the loop so the
  // last-resort return below cannot fall back to one either.
  const parts = withoutHome.split('/').filter(Boolean).filter((p) => !DRIVE_LETTER.test(p))
  if (parts.length === 0) return 'unknown'
  // config.projectRoots adds to the built-in set rather than replacing it.
  // Leaving the default alone matters: someone with a single project directly
  // under Desktop is correctly served by grouping on "Desktop" today, and
  // changing that for everyone would silently regroup their history.
  const roots = extraRoots?.length
    ? new Set([...CWD_WORKSPACE_ROOTS, ...extraRoots])
    : CWD_WORKSPACE_ROOTS
  for (const part of parts) {
    if (!roots.has(part)) return part
  }
  return parts[parts.length - 1] ?? 'unknown'
}

const GENERIC_DIRECTORY_NAMES = new Set([
  'sessions',
  'session',
  'logs',
  'log',
  'data',
  'tmp',
  'temp',
  'cache',
  '.claude',
  '.codex',
  '.opencode',
  '.openclaw',
  '.qoder',
  '.kimi',
  '.kimi-code',
  '.codebuddy',
  '.kiro',
  '.grok',
  '.gemini',
  '.omp',
  '.pi',
  '.craft-agent',
  '.droid',
  'projects',
  'runs',
  'wire',
  'globalStorage',
  'dev_data',
])

const TOOL_DIRECTORY_NAMES = new Set(['agents', 'main'])

export function extractProject(sourceFile: string): string {
  if (!sourceFile) return 'unknown'
  return extractProjectFromClaudePath(sourceFile)
    ?? extractProjectFromKnownToolPath(sourceFile)
    ?? extractProjectFromGenericPath(sourceFile)
    ?? 'unknown'
}

/**
 * Decode an encoded project path (where `/` was replaced with `-`) into a
 * human-readable name. Known workspace roots (WebstormProjects, Documents, …)
 * are stripped and the remaining segments are joined with `/` so that
 * multi-level paths like `org/project` are preserved correctly.
 */
function decodeEncodedPath(raw: string): string {
  const parts = raw.split('-').filter(Boolean)

  const WORKSPACE_ROOTS = ['WebstormProjects', 'Documents', 'Projects', 'workspace', 'Workspace']
  for (const root of WORKSPACE_ROOTS) {
    const idx = parts.indexOf(root)
    if (idx >= 0 && idx < parts.length - 1) {
      return parts.slice(idx + 1).join('/')
    }
  }

  const meaningful = parts.filter(p => !looksMachineGenerated(p))
  if (meaningful.length === 0) return raw
  if (meaningful.length <= 3) return meaningful[meaningful.length - 1] ?? '~'
  return meaningful.slice(-2).join('/')
}

function extractProjectFromClaudePath(sourceFile: string): string | null {
  const normalized = sourceFile.replace(/\\/g, '/')
  const match = normalized.match(/\.claude\/projects\/([^/]+)/)
  if (!match) return null
  return decodeEncodedPath(match[1])
}

function extractProjectFromKnownToolPath(sourceFile: string): string | null {
  const normalized = sourceFile.replace(/\\/g, '/')

  const qoderSessionMatch = normalized.match(/\/\.qoder\/logs\/sessions\/([^/]+)\//)
  if (qoderSessionMatch) return decodeEncodedPath(qoderSessionMatch[1])

  const codeBuddyProjectMatch = normalized.match(/\/\.codebuddy\/projects\/([^/]+)\//)
  if (codeBuddyProjectMatch) return decodeEncodedPath(codeBuddyProjectMatch[1])

  const kimiSessionMatch = normalized.match(/\/\.kimi-code\/sessions\/([^/]+)\//)
  if (kimiSessionMatch) return decodeEncodedPath(kimiSessionMatch[1])

  const legacyKimiSessionMatch = normalized.match(/\/\.kimi\/sessions\/([^/]+)\//)
  if (legacyKimiSessionMatch) return decodeEncodedPath(legacyKimiSessionMatch[1])

  const taskMatch = normalized.match(/\/globalStorage\/(?:rooveterinaryinc\.roo-cline|kilocode\.kilo-code)\/tasks\/([^/]+)\//)
  if (taskMatch) return `task/${taskMatch[1]}`

  if (normalized.includes('/.openclaw/')) {
    // Path: ~/.openclaw/agents/<agent_name>/sessions/<uuid>.jsonl
    const agentMatch = normalized.match(/\.openclaw\/agents\/([^/]+)\//)
    if (agentMatch) return `openclaw/${agentMatch[1]}`
  }

  if (normalized.includes('/.codex/') || normalized.includes('/.opencode/')) {
    return extractProjectFromGenericPath(normalized)
  }

  if (normalized.includes('/.qoder/logs/runs/')) {
    return 'unknown'
  }

  // Hermes: sourceFile format is "dbPath:session:id:title" or "dbPath:session:id"
  const hermesMatch = normalized.match(/:session:[^:]+:(.+)$/)
  if (hermesMatch) return hermesMatch[1]
  // Hermes without title
  if (normalized.match(/:session:[^:]+$/)) return 'hermes'

  return null
}

/**
 * A home directory, in every shape this sees.
 *
 * The same strip extractProjectFromCwd has done all along; the walk below
 * never had it, which is why it reached the username.
 */
const HOME_PREFIX = [
  /^[A-Za-z]:\/(?:Users|home)\/[^/]+(?:\/|$)/,
  /^\/(?:Users|home)\/[^/]+(?:\/|$)/,
  /^\/root(?:\/|$)/,
]

function extractProjectFromGenericPath(sourceFile: string): string | null {
  const normalized = sourceFile.replace(/\\/g, '/')
  const directory = path.posix.dirname(normalized)

  /*
   * A username is not a project. The third time this file has had to say so.
   *
   * The first was the drive letter, which made "C:" a project. The second was
   * the home directory itself, which made "Users" one. Both are recorded
   * above as the same mistake: inventing a project that does not exist,
   * because the walk had nothing left to return and returned the last thing
   * it saw anyway.
   *
   * This is the third and the one that survived. Codex desktop sessions are
   * logged at ~/.codex/sessions/<year>/<month>/<day>/rollout-<uuid>.jsonl and
   * carry no working directory at all — 1750 of 2199 rows here have an empty
   * cwd — so the walk skipped the date parts, skipped sessions and .codex,
   * and landed on the username. Two machines with the same username were
   * reported as one project named after the person using them.
   *
   * Consuming the home prefix first means the walk has nothing to reach past,
   * and the honest answer comes out instead: the path does not say which
   * project this was, so nothing here does.
   */
  const withoutHome = HOME_PREFIX.reduce((acc, re) => acc.replace(re, ''), directory)
  if (!withoutHome) return null

  const parts = withoutHome.split('/').filter(Boolean)

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const candidate = parts[index]
    if (isSkippableDirectoryName(candidate)) continue
    if (looksMachineGenerated(candidate)) continue
    if (isPurelyNumeric(candidate)) {
      if (index > 0) {
        const parent = parts[index - 1]
        if (!isSkippableDirectoryName(parent) && !looksMachineGenerated(parent) && !isPurelyNumeric(parent)) {
          return `${parent}/${candidate}`
        }
      }
      continue  // no meaningful parent, skip this numeric segment
    }
    return candidate
  }

  return null
}

function isSkippableDirectoryName(name: string): boolean {
  return GENERIC_DIRECTORY_NAMES.has(name) || TOOL_DIRECTORY_NAMES.has(name)
}

function looksMachineGenerated(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(name)
    || /^[0-9a-f]{8,}$/i.test(name)
    || /^[0-9a-f-]{32,}$/i.test(name)
}

function isPurelyNumeric(name: string): boolean {
  return /^\d+$/.test(name)
}
