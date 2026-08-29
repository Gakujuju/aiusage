/**
 * Turning a project key into something to show a person.
 *
 * The key stays whatever the path extraction produced — it is the join key
 * against records and agent_sessions, and renaming it would orphan history.
 * The display name is a separate, purely cosmetic layer on top.
 */

/**
 * The label to show for a project.
 *
 * Falls back to the key itself, so an unmapped project reads exactly as it
 * did before anyone configured aliases.
 */
export function resolveProjectDisplayName(
  project: string,
  aliases?: Record<string, string>,
): string {
  if (typeof project !== 'string' || !project) return project ?? ''
  const alias = aliases?.[project]
  return typeof alias === 'string' && alias.trim() ? alias : project
}
