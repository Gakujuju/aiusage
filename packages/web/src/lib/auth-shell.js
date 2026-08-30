/**
 * Which of the three shells the layout should render.
 *
 * The home page used to be special: upstream served /api/summary and
 * /api/quotas without a password, so an unauthenticated visitor could see the
 * headline figures and log in only when they wanted more. Protecting every
 * /api/ path on a non-loopback bind took that away, and this function did not
 * know — so home kept rendering its public variant against endpoints that
 * answered 401, with no login form anywhere on the page. A locked door with
 * no handle.
 *
 * @param {object} input
 * @param {string} input.pathname
 * @param {boolean} input.authEnabled
 * @param {boolean} input.authenticated
 * @param {boolean} input.authLoading
 * @param {boolean} [input.publicHome] whether home can show anything without
 *   a login. Only the server knows; absent means the old behaviour, where it
 *   always could.
 * @returns {'shell' | 'public-home' | 'login-page' | 'loading'}
 */
export function getAuthShellState({
  pathname,
  authEnabled,
  authenticated,
  authLoading,
  publicHome = true,
}) {
  const isHome = pathname === '/'
  if (authLoading) return isHome ? 'public-home' : 'loading'
  if (!authEnabled || authenticated) return 'shell'
  return isHome && publicHome ? 'public-home' : 'login-page'
}
