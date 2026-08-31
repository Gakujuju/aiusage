import { get } from 'svelte/store'
import { t } from './i18n.js'

function buildUrl(base, params) {
  const searchParams = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value) searchParams.set(key, value)
  }
  const query = searchParams.toString()
  return query ? `${base}?${query}` : base
}

// Stale-while-revalidate cache (§11.4)
const swrCache = new Map()
const inflightRequests = new Map()

/**
 * Told about every 401 that comes back from the API.
 *
 * A session can lapse while the dashboard is open. Without this the shell
 * keeps rendering as if logged in, every page fills with "Authentication
 * required", and there is no login form anywhere to fix it — the reader is
 * left pressing refresh. One signal here lets the layout notice and put the
 * form back in front of them.
 *
 * @type {null | (() => void)}
 */
let unauthorizedHandler = null

/** @param {null | (() => void)} handler */
export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = handler
}

function reportUnauthorized(url) {
  // Not the auth endpoints themselves: /api/auth/login answers 401 for a
  // wrong password, and re-checking the session on that would be noise.
  if (url.startsWith('/api/auth/')) return
  if (unauthorizedHandler) unauthorizedHandler()
}

/**
 * How many times to try again when the server cannot be reached at all.
 *
 * A dashboard left open on a phone loses its server for a second or two
 * whenever serve is restarted, and the reader saw "API error" and had to
 * know to press refresh. Three and a half seconds covers that window.
 *
 * Deliberately not longer. A real outage lasts until the watchdog's next
 * tick — minutes, not seconds — and no retry schedule is going to cover
 * that. Waiting longer would only replace a wrong answer with a long silence
 * before the same answer.
 */
const OFFLINE_RETRY_DELAYS_MS = [500, 1000, 2000]

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Say what went wrong in a way the reader can act on.
 *
 * "API error" was true of everything — the server being down, the session
 * having lapsed, a bug in a query — and told nobody which. The message is
 * resolved here rather than at each page so that every page gets it without
 * being touched, and it goes through the same translations as the rest.
 *
 * @param {'offline' | 'server' | 'other'} kind
 * @param {string} [serverMessage]
 */
function describeFailure(kind, serverMessage) {
  const translate = get(t)
  if (kind === 'offline') return translate('errors.offline')
  if (kind === 'server') return translate('errors.server')
  return serverMessage || translate('errors.unknown')
}

/**
 * An Error that also says what kind of failure it was, so a caller can tell
 * an unreachable server from one that answered.
 *
 * @param {string} message
 * @param {'offline' | 'server' | 'other'} kind
 * @param {number} [status]
 */
function apiError(message, kind, status) {
  return Object.assign(new Error(message), { kind, status })
}

async function apiFetch(url, { signal, swr = false } = {}) {
  /**
   * A fetch that rejects only once the server has had a few chances.
   *
   * Retries are for unreachability alone: a 500 is the server answering, and
   * asking again just repeats whatever went wrong. An aborted request is the
   * caller's decision and must not be second-guessed.
   */
  const request = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return signal ? await fetch(url, { signal }) : await fetch(url)
      } catch (error) {
        if (signal?.aborted) throw error
        if (attempt >= OFFLINE_RETRY_DELAYS_MS.length) throw error
        await sleep(OFFLINE_RETRY_DELAYS_MS[attempt])
      }
    }
  }

  // Stale-while-revalidate: return cached data immediately, refresh in background
  if (swr && swrCache.has(url)) {
    const cached = swrCache.get(url)
    // Revalidate in background if stale (> 5s)
    if (Date.now() - cached.fetchedAt > 5000 && !inflightRequests.has(url)) {
      const promise = request()
        .then(r => r.ok ? r.json() : null)
        .then(data => { if (data) swrCache.set(url, { data, fetchedAt: Date.now() }) })
        .catch(() => {})
        .finally(() => inflightRequests.delete(url))
      inflightRequests.set(url, promise)
    }
    return cached.data
  }

  // Deduplicate in-flight requests
  if (inflightRequests.has(url)) {
    return inflightRequests.get(url)
  }

  const promise = request()
    .then(async (response) => {
      if (!response.ok) {
        if (response.status === 401) reportUnauthorized(url)
        const body = await response.json().catch(() => null)
        const serverMessage = body?.error?.message
        // 5xx is the server failing; 4xx is usually something it can explain
        // better than we can, so its own message wins there.
        const kind = response.status >= 500 ? 'server' : 'other'
        throw apiError(describeFailure(kind, serverMessage), kind, response.status)
      }
      return response.json()
    })
    .then(data => {
      if (swr) swrCache.set(url, { data, fetchedAt: Date.now() })
      return data
    })
    .catch((error) => {
      // Only a fetch that never got an answer lands here without a kind: the
      // branch above sets one on everything the server did reply to.
      if (error?.kind || error?.name === 'AbortError') throw error
      throw apiError(describeFailure('offline'), 'offline')
    })
    .finally(() => inflightRequests.delete(url))

  inflightRequests.set(url, promise)
  return promise
}

export async function fetchSummary(params, { signal, swr = true } = {}) {
  return apiFetch(buildUrl('/api/summary', params), { signal, swr })
}

export async function fetchBootstrap(params = {}) {
  return apiFetch(buildUrl('/api/bootstrap', params))
}

export async function fetchTokens(params) {
  return apiFetch(buildUrl('/api/tokens', params))
}

export async function fetchCost(params) {
  return apiFetch(buildUrl('/api/cost', params))
}

export async function fetchModels(params) {
  return apiFetch(buildUrl('/api/models', params))
}

export async function fetchToolCalls(params) {
  return apiFetch(buildUrl('/api/tool-calls', {
    ...params,
    toolType: params.toolType || undefined,
  }))
}

export async function fetchSessions(params) {
  return apiFetch(buildUrl('/api/sessions', {
    ...params,
    page: params.page?.toString(),
    pageSize: params.pageSize?.toString(),
  }))
}

export async function fetchSessionDetail(sessionId, params = {}) {
  return apiFetch(buildUrl(`/api/sessions/${encodeURIComponent(sessionId)}`, params))
}

export async function fetchProjects(params) {
  return apiFetch(buildUrl('/api/projects', params))
}

export async function refreshData() {
  return apiFetch('/api/refresh')
}

export async function fetchPricing() {
  return apiFetch('/api/pricing')
}

export async function updatePricing(model, entry) {
  const response = await fetch('/api/pricing', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, ...entry }),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'API error' } }))
    throw new Error(error.error?.message || `HTTP ${response.status}`)
  }
  return response.json()
}

export async function deletePricing(model) {
  const response = await fetch(`/api/pricing?model=${encodeURIComponent(model)}`, { method: 'DELETE' })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'API error' } }))
    throw new Error(error.error?.message || `HTTP ${response.status}`)
  }
  return response.json()
}

export async function bindPricingAlias(alias, modelKey) {
  const response = await fetch('/api/pricing/alias', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ alias, modelKey }),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'API error' } }))
    throw new Error(error.error?.message || `HTTP ${response.status}`)
  }
  return response.json()
}

export async function unbindPricingAlias(alias) {
  const response = await fetch(`/api/pricing/alias?alias=${encodeURIComponent(alias)}`, { method: 'DELETE' })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'API error' } }))
    throw new Error(error.error?.message || `HTTP ${response.status}`)
  }
  return response.json()
}

export async function recalcPricing() {
  const response = await fetch('/api/pricing/recalc', { method: 'POST' })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'API error' } }))
    throw new Error(error.error?.message || `HTTP ${response.status}`)
  }
  return response.json()
}

export async function fetchPricingRecalcStatus() {
  const response = await fetch('/api/pricing/recalc', { cache: 'no-store' })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'API error' } }))
    throw new Error(error.error?.message || `HTTP ${response.status}`)
  }
  return response.json()
}

export async function syncPricing() {
  const response = await fetch('/api/pricing/sync', { method: 'POST' })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'API error' } }))
    throw new Error(error.error?.message || `HTTP ${response.status}`)
  }
  return response.json()
}

export async function triggerSync() {
  const response = await fetch('/api/sync', { method: 'POST' })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'API error' } }))
    throw new Error(error.error?.message || `HTTP ${response.status}`)
  }
  return response.json()
}

export async function fetchSyncStatus() {
  return apiFetch('/api/sync')
}

export async function fetchCloudSyncStatus(siteUrl) {
  try {
    const response = await fetch('/api/cli/sync/status')
    if (!response.ok) return { enabled: false }
    return response.json()
  } catch {
    try {
      const response = await fetch(`${siteUrl}/api/cli/sync/status`)
      if (!response.ok) return { enabled: false }
      return response.json()
    } catch {
      return { enabled: false }
    }
  }
}

/**
 * Whether log parsing is still happening.
 *
 * The scheduled parse only writes a log line when it found something, so a
 * quiet log is equally consistent with “nothing to do” and “not running”.
 * This is the state rather than the events, which is why it can be asked at
 * any moment instead of inferred from an absence.
 */
export async function fetchHealth() {
  return apiFetch('/api/health')
}

export async function fetchConfig() {
  return apiFetch('/api/config')
}

export async function saveConfig(data) {
  const response = await fetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'API error' } }))
    throw new Error(error.error?.message || `HTTP ${response.status}`)
  }
  return response.json()
}

export async function fetchTools(params) {
  return apiFetch(buildUrl('/api/tools', params))
}

export async function fetchDetectedTools() {
  return apiFetch('/api/detected-tools')
}

export async function importKelivoBackup(file) {
  const form = new FormData()
  form.append('file', file)
  const response = await fetch('/api/import/kelivo', { method: 'POST', body: form })
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(data?.error?.message || `HTTP ${response.status}`)
  }
  return data
}

export async function fetchQuotas() {
  return apiFetch('/api/quotas')
}

/** @param {Record<string, string | undefined>} params */
export async function fetchQuotaHistory(params = {}) {
  return apiFetch(buildUrl('/api/quotas/history', params))
}

/** @param {Record<string, string | undefined>} params */
export async function fetchQuotaForecast(params = {}) {
  return apiFetch(buildUrl('/api/quotas/forecast', params))
}

export async function fetchAgentSummary() {
  return apiFetch('/api/agent/summary')
}

/** @param {Record<string, string | undefined>} params */
export async function fetchNotifications(params = {}) {
  return apiFetch(buildUrl('/api/notifications', params))
}

export async function fetchNotificationSummary() {
  return apiFetch('/api/notifications/summary')
}

export async function sendNotificationTest() {
  const response = await fetch('/api/notifications/test', { method: 'POST' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

/** @param {string} id */
export async function retryNotification(id) {
  const response = await fetch(`/api/notifications/${encodeURIComponent(id)}/retry`, { method: 'POST' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

/** @param {Record<string, string | undefined>} params */
export async function fetchAgentSessions(params = {}) {
  return apiFetch(buildUrl('/api/agent/sessions', params))
}

export async function fetchAuthStatus() {
  return apiFetch('/api/auth/status')
}

export async function login(password) {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'API error' } }))
    throw new Error(error.error?.message || `HTTP ${response.status}`)
  }
  return response.json()
}

export async function fetchLeaderboard(baseUrl, params = {}) {
  const data = await apiFetch(buildUrl('/api/leaderboard', {
    period_type: params.period_type,
    period_start: params.period_start,
    cursor: params.cursor,
  }))
  if (!data || !Array.isArray(data.entries)) {
    throw new Error('Invalid leaderboard response')
  }
  return data
}

export async function fetchLeaderboardAuthStatus() {
  return apiFetch('/api/leaderboard/auth/status')
}

export async function startLeaderboardAuth() {
  const response = await fetch('/api/leaderboard/auth/start', { method: 'POST' })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'API error' } }))
    throw new Error(error.error?.message || `HTTP ${response.status}`)
  }
  return response.json()
}

export async function completeLeaderboardAuth(deviceRequestId) {
  const response = await fetch('/api/leaderboard/auth/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_request_id: deviceRequestId }),
  })
  const data = await response.json().catch(() => null)
  if (response.status === 202 || data?.pending) return data || { pending: true }
  if (!response.ok) {
    throw new Error(data?.error?.message || `HTTP ${response.status}`)
  }
  return data
}

export async function logoutLeaderboardAuth() {
  const response = await fetch('/api/leaderboard/auth/logout', { method: 'POST' })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'API error' } }))
    throw new Error(error.error?.message || `HTTP ${response.status}`)
  }
  return response.json()
}

export async function uploadLeaderboardData() {
  const response = await fetch('/api/leaderboard/upload', { method: 'POST' })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'API error' } }))
    throw new Error(error.error?.message || `HTTP ${response.status}`)
  }
  return response.json()
}

export async function refreshExchangeRate() {
  const response = await fetch('/api/exchange-rate/refresh', { method: 'POST' })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'API error' } }))
    throw new Error(error.error?.message || `HTTP ${response.status}`)
  }
  return response.json()
}

export async function fetchCredential(ref) {
  return apiFetch(buildUrl('/api/config/credential', { ref }))
}

export const SETTINGS_UPDATED_EVENT = 'aiusage:settings-updated'

export function notifySettingsUpdated(patch) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(SETTINGS_UPDATED_EVENT, { detail: patch }))
}

/**
 * Web Push.
 *
 * The status endpoint returns the public VAPID key and a summary of the
 * registered devices. It never returns p256dh or auth: those are what allow
 * a message to be encrypted for a browser, and a GET that handed them back
 * would turn read access into the ability to push.
 */
export async function fetchPushStatus() {
  const response = await fetch('/api/push/status')
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

/** @param {{ endpoint: string, keys: { p256dh: string, auth: string } }} subscription @param {string} label */
export async function savePushSubscription(subscription, label) {
  const response = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...subscription, label }),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'API error' } }))
    throw new Error(error.error?.message || `HTTP ${response.status}`)
  }
  return response.json()
}

/** @param {string} id */
export async function deletePushSubscription(id) {
  const response = await fetch(`/api/push/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

export async function sendPushTest() {
  const response = await fetch('/api/push/test', { method: 'POST' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}
