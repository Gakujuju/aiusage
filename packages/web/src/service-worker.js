/// <reference lib="webworker" />
import { build, files, version } from '$service-worker'

/**
 * Cache the shell. Never cache the numbers.
 *
 * This app answers "how much have I spent". A stale figure served from a cache
 * is worse than no figure at all, because nothing about it looks stale — so
 * /api/ never touches the cache in either direction, and going offline shows
 * an error rather than yesterday's total.
 *
 * What is cached is only the shell: the JS, CSS, fonts and the one HTML page
 * the SPA boots from. Those are content-hashed by Vite, so a new build is a
 * new set of URLs and there is nothing to invalidate by hand.
 */

const CACHE = `aiusage-shell-${version}`

/**
 * `/` matters on its own: adapter-static runs in SPA mode, so `prerendered` is
 * empty and index.html is the only entry point every route falls back to.
 */
const SHELL = [...build, ...files, '/']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      // A shell that fails to precache is not a reason to keep the old worker
      // around; it will fill in from the network on demand.
      .catch(() => undefined),
  )
})

/*
 * No skipWaiting here, deliberately.
 *
 * It used to take over the moment it was ready, which sounds like the fast
 * choice and is not. The page that triggered the update had already booted
 * from the old bundle and nothing reloaded it, so the new screen still only
 * appeared on the next launch — always exactly one behind — while activate
 * deleted the cache the running page was still using. A route it had not
 * loaded yet would then 404, and serve answers unknown paths with
 * index.html, so the old page could receive HTML where it expected a script.
 *
 * Now the new worker waits until someone decides. The page applies it when
 * the reader comes back to the app, or offers a button while they are
 * looking at it. Either way the old cache stays whole until the moment of
 * the reload.
 */
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
  if (event.data?.type === 'VERSION') {
    // Answered so the app can show which shell it is running. Which build the
    // screen came from is not otherwise knowable from inside the page, and on
    // a phone there are no developer tools to ask with.
    // Over the port when the asker opened one, otherwise straight back to
    // the client. Both are used: the settings screen wants a reply it can
    // await, and a plain postMessage is simpler from anywhere else.
    const reply = { type: 'VERSION', version }
    if (event.ports && event.ports[0]) event.ports[0].postMessage(reply)
    else event.source?.postMessage(reply)
  }
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      // Building the web package replaces what production serves immediately,
      // with no restart involved. A worker that waited for every tab to close
      // would keep handing out the previous shell against a server that has
      // already moved on, so it takes over as soon as it is ready.
      .then(() => self.clients.claim()),
  )
})

/** Is this a request we are willing to answer from the cache? */
function cacheable(request, url) {
  if (request.method !== 'GET') return false
  if (url.origin !== self.location.origin) return false
  if (url.pathname.startsWith('/api/')) return false
  return true
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (!cacheable(event.request, url)) return // Straight to the network.

  event.respondWith((async () => {
    const cache = await caches.open(CACHE)

    const hit = await cache.match(event.request)
    if (hit) return hit

    try {
      const response = await fetch(event.request)

      /**
       * serve answers any unknown path with index.html rather than a 404, so a
       * miss for a stale asset comes back as a perfectly valid HTML page. Only
       * URLs this build actually produced get stored, which keeps that HTML
       * from being cached under a .js name and breaking the next load.
       */
      const known = SHELL.includes(url.pathname)
      if (known && response.status === 200 && response.type === 'basic') {
        cache.put(event.request, response.clone())
      }
      return response
    } catch (error) {
      /**
       * Offline. A navigation can still be answered with the shell — the app
       * loads and its own error handling explains that the data will not come.
       * Anything else fails, which is the honest outcome.
       */
      if (event.request.mode === 'navigate') {
        const shell = await cache.match('/')
        if (shell) return shell
      }
      throw error
    }
  })())
})

/**
 * Web Push.
 *
 * Nothing below touches the cache. A push carries its own text and the fetch
 * handler above is left exactly as it was — in particular /api/ still never
 * reaches the cache in either direction.
 */

/** Where a tap on this notification should land. */
function targetPathFor(subjectKind) {
  if (subjectKind === 'agent_session') return '/agents'
  if (subjectKind === 'quota') return '/quotas'
  return '/'
}

self.addEventListener('push', (event) => {
  /**
   * A push with no readable payload still has to show something. The push
   * service can wake us with an empty body, and on most platforms a service
   * worker that returns from `push` without calling showNotification gets a
   * generic "site updated in the background" notice instead — which is worse
   * than a vague one of our own.
   */
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }

  const title = typeof data.title === 'string' && data.title ? data.title : 'aiusage'
  const body = typeof data.body === 'string' ? data.body : ''
  const subjectKind = typeof data.subjectKind === 'string' ? data.subjectKind : ''

  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    /**
     * Same subject replaces rather than stacks: a quota that crosses two
     * thresholds while the phone is locked should leave one notification
     * saying where it ended up, not two saying where it passed.
     */
    tag: typeof data.tag === 'string' && data.tag ? data.tag : undefined,
    data: { path: targetPathFor(subjectKind), subjectKind },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const path = event.notification.data?.path ?? '/'
  const url = new URL(path, self.location.origin)

  event.waitUntil((async () => {
    /**
     * Reuse a tab that is already open rather than piling up windows. Only
     * our own origin is considered, and `includeUncontrolled` matters because
     * a tab loaded before this worker took over is still the tab the user
     * means.
     */
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of clients) {
      if (new URL(client.url).origin !== url.origin) continue
      // Navigate first so the focused tab shows the thing that was announced,
      // not wherever it happened to be left.
      if ('navigate' in client) await client.navigate(url.href).catch(() => undefined)
      return client.focus()
    }
    return self.clients.openWindow(url.href)
  })())
})
