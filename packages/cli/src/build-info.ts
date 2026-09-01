/**
 * Which build this is.
 *
 * Baked in by tsup from git. A spoke reports these to the hub so the hub
 * can say which machines are running older code than it is — the question
 * "which ones did I update?" answered by the machines rather than by
 * memory.
 *
 * Both values are null outside a build (running from source, or built
 * without git). Absent means unknown, never out of date.
 */

declare const __COMMIT__: string | null | undefined
declare const __COMMIT_TIME__: number | null | undefined

export interface BuildInfo {
  commit: string | null
  /** Unix seconds of the commit itself, not of the build. */
  commitTime: number | null
}

export function buildInfo(): BuildInfo {
  return {
    commit: typeof __COMMIT__ === 'string' ? __COMMIT__ : null,
    commitTime: typeof __COMMIT_TIME__ === 'number' ? __COMMIT_TIME__ : null,
  }
}
