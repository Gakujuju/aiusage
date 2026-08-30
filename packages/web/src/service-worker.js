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
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  )
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
