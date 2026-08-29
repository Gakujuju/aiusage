import { createHash, timingSafeEqual } from 'node:crypto'
import type http from 'node:http'

export const AUTH_COOKIE_NAME = 'aiusage_dashboard_auth'
const AUTH_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60

export function getDashboardPassword(): string | null {
  const password = process.env.AIUSAGE_DASHBOARD_PASSWORD?.trim()
  return password ? password : null
}

export function verifyPassword(configuredPassword: string | null | undefined, submittedPassword: string | null | undefined): boolean {
  if (!configuredPassword) return true
  if (!submittedPassword) return false
  return safeEqual(configuredPassword, submittedPassword)
}

export function buildAuthCookie(password: string): string {
  return `${AUTH_COOKIE_NAME}=${hashPassword(password)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${AUTH_COOKIE_MAX_AGE_SECONDS}`
}

export function buildClearAuthCookie(): string {
  return `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

export function isAuthenticated(configuredPassword: string | null | undefined, cookieHeader: string | null | undefined): boolean {
  if (!configuredPassword) return true
  const cookies = parseCookies(cookieHeader ?? '')
  const token = cookies.get(AUTH_COOKIE_NAME)
  if (!token) return false
  return safeEqual(token, hashPassword(configuredPassword))
}

export function isPublicPath(pathname: string): boolean {
  if (pathname === '/' || pathname === '/index.html') return true
  if (pathname === '/api/auth/status' || pathname === '/api/auth/login' || pathname === '/api/auth/logout') return true
  return isStaticAssetPath(pathname)
}

/**
 * Loopback addresses, matched as strings.
 *
 * Deliberately no DNS resolution: once you start asking what 'localhost'
 * resolves to on this particular machine there is no natural stopping point,
 * and a security decision should not depend on a lookup that can change.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '[::1]'])

export function isLoopbackHost(host: string | null | undefined): boolean {
  if (typeof host !== 'string') return false
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase())
}

/**
 * `isLoopback` defaults to true so existing callers keep the original
 * behaviour. On a loopback bind the two exempt endpoints are harmless — the
 * only reader is the person at the keyboard. Reachable from the network they
 * are the opposite: /api/summary is the total spend and /api/quotas is the
 * subscription burn, which is most of what there is to keep private here.
 */
export function shouldProtectApiPath(pathname: string, isLoopback = true): boolean {
  if (!pathname.startsWith('/api/')) return false
  if (isPublicPath(pathname)) return false

  // The public home page depends on summary and quota display data.
  if (isLoopback) {
    if (pathname === '/api/summary') return false
    if (pathname === '/api/quotas') return false
  }
  return true
}

export function requireAuth(password: string | null, req: http.IncomingMessage): boolean {
  return isAuthenticated(password, req.headers.cookie)
}

function hashPassword(password: string): string {
  return createHash('sha256').update(password).digest('hex')
}

function parseCookies(cookieHeader: string): Map<string, string> {
  const cookies = new Map<string, string>()
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const name = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (name) cookies.set(name, value)
  }
  return cookies
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function isStaticAssetPath(pathname: string): boolean {
  return /\.(?:js|css|json|png|jpg|jpeg|svg|ico|woff|woff2|map)$/i.test(pathname)
}
