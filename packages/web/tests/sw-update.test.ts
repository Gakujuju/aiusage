import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * When a new build reaches an installed app, and on whose terms.
 *
 * The worker already skipped waiting and claimed its clients, so the obvious
 * culprits were not it. What nothing did was ask: SvelteKit calls
 * registration.update() only just before a hard navigation, which a
 * single-page app almost never performs. Launching the app did check, but by
 * then the page had booted from the old bundle — so the new screen appeared
 * on the launch after that, always exactly one behind. Three times in one day
 * that ended in "please reopen the app".
 *
 * These pin the two decisions rather than the plumbing: the worker no longer
 * takes over behind a running page, and the page applies an update when the
 * reader comes back rather than while they are reading.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const sw = read('../src/service-worker.js')
const client = read('../src/lib/sw-update.js')
const layout = read('../src/routes/+layout.svelte')

describe('the worker waits instead of taking over', () => {
  it('does not skip waiting during install', () => {
    // Taking over behind a running page is what deleted the cache that page
    // was still using, and it never made the new screen appear any sooner.
    //
    // Matching the call rather than the word: the comment in the worker
    // explains at length why skipWaiting is not there, and names it doing so.
    const install = sw.slice(sw.indexOf("addEventListener('install'"), sw.indexOf("addEventListener('message'"))
    expect(install).not.toMatch(/self\.skipWaiting\(\)/)
  })

  it('skips waiting only when the page asks it to', () => {
    expect(sw).toContain("event.data?.type === 'SKIP_WAITING'")
    expect(sw).toContain('self.skipWaiting()')
  })

  it('still claims clients once it does activate', () => {
    expect(sw).toContain('self.clients.claim()')
  })

  it('can say which build it is serving', () => {
    // The page has no other way to know, and a phone has no console to ask.
    expect(sw).toContain("event.data?.type === 'VERSION'")
    expect(sw).toContain('version')
  })
})

describe('the page decides when to apply it', () => {
  it('applies on the way back into the app', () => {
    expect(client).toContain("document.addEventListener('visibilitychange'")
    const onVisible = client.slice(client.indexOf('const onVisible'), client.indexOf("document.addEventListener('visibilitychange'"))
    expect(onVisible).toContain('registration?.waiting')
    expect(onVisible).toContain('apply()')
  })

  it('never swaps the screen while it is being looked at', () => {
    // Exactly two calls, and the tests above show them to be the visibility
    // handler and the button. Nothing else reloads on its own, which is the
    // whole promise: the screen is never swapped while it is being read.
    const applyCalls = client.split("apply()").length - 1
      - (client.includes("function apply()") ? 1 : 0)
    expect(applyCalls).toBe(2)
    expect(client).toContain('export function applyUpdate')
  })

  it('offers a band when the reader is present', () => {
    expect(layout).toContain('$updateReady')
    expect(layout).toContain('applyUpdate')
  })

  it('asks periodically, because an open app is never navigated', () => {
    expect(client).toContain('setInterval(check')
  })

  it('reloads only after the new worker has taken over', () => {
    // Reloading before that would just fetch the old shell again.
    expect(client).toContain("addEventListener('controllerchange'")
    expect(client).toContain('window.location.reload()')
  })

  it('stops listening when the layout goes away', () => {
    expect(client).toContain('removeEventListener')
    expect(client).toContain('clearInterval(timer)')
  })
})

describe('the cache rules are unchanged', () => {
  it('still refuses to cache the API', () => {
    // The figures must never come from a cache; a stale total looks exactly
    // like a fresh one. Guarded here because this change touched the worker.
    expect(sw).toContain("url.pathname.startsWith('/api/')")
    const cacheable = sw.slice(sw.indexOf('function cacheable'), sw.indexOf("addEventListener('fetch'"))
    expect(cacheable).toContain('return false')
  })

  it('leaves the fetch handler alone', () => {
    expect(sw).toContain('const hit = await cache.match(event.request)')
    expect(sw).toContain('if (hit) return hit')
  })
})
