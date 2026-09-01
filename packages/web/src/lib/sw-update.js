import { writable } from 'svelte/store'

/**
 * Noticing that a new version of the screen is available, and applying it.
 *
 * The service worker was never the problem. It already skipped waiting and
 * claimed its clients; what nothing did was *ask*. SvelteKit calls
 * registration.update() only just before a hard navigation, which in a
 * single-page app is close to never, so an app left open never learned there
 * was anything newer. Launching it did check — but the page had already
 * booted from the old bundle, so the new screen arrived on the launch after
 * that. Always exactly one behind, three times in one day.
 *
 * Two moments are handled differently, on the principle that the reader's
 * attention is the thing being protected:
 *
 *   away, then back  -> apply it silently. Coming back is not the middle of
 *                       anything, and it is the moment they used to perform
 *                       by hand when told to reopen the app.
 *   sitting there     -> offer a band. Swapping the screen out from under
 *                       someone reading it trades one bad surprise for
 *                       another.
 *
 * A reload keeps what they were looking at: the route is in the URL, and the
 * range, device and tool filters are in localStorage. Checked rather than
 * assumed — an auto-apply that discarded the view would defeat the point.
 */

/** True when a new worker is installed and waiting for permission. */
export const updateReady = writable(false)

/** The build this screen was served from, once the worker has said. */
export const shellVersion = writable(null)

/** How often to ask, for an app that stays open. */
const POLL_MS = 20 * 60 * 1000

/** @type {ServiceWorkerRegistration | null} */
let registration = null
let reloading = false

function apply() {
  if (reloading || !registration?.waiting) return
  reloading = true
  // controllerchange fires once the waiting worker takes over; reloading then
  // means the new page is served by the new worker rather than racing it.
  registration.waiting.postMessage({ type: 'SKIP_WAITING' })
}

/** Apply the waiting update now. Called from the band. */
export function applyUpdate() {
  apply()
}

export function initServiceWorkerUpdates() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {}

  const onControllerChange = () => {
    if (!reloading) return
    window.location.reload()
  }
  navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)

  /** @param {ServiceWorkerRegistration} reg */
  const track = (reg) => {
    registration = reg
    if (reg.waiting) updateReady.set(true)

    reg.addEventListener('updatefound', () => {
      const installing = reg.installing
      if (!installing) return
      installing.addEventListener('statechange', () => {
        // 'installed' with a controller present means an update rather than a
        // first install; without one it is the very first visit and there is
        // nothing to announce.
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          updateReady.set(true)
        }
      })
    })
  }

  navigator.serviceWorker.getRegistration().then((reg) => {
    if (!reg) return
    track(reg)
    reg.update().catch(() => {})
    askVersion()
  }).catch(() => {})

  const check = () => registration?.update().catch(() => {})

  const onVisible = () => {
    if (document.visibilityState !== 'visible') return
    check()
    // Back from elsewhere: apply whatever is ready without asking. This is
    // the moment people were performing by hand when told to reopen the app.
    if (registration?.waiting) apply()
  }
  document.addEventListener('visibilitychange', onVisible)

  const timer = setInterval(check, POLL_MS)

  return () => {
    document.removeEventListener('visibilitychange', onVisible)
    navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
    clearInterval(timer)
  }
}

/**
 * Ask the worker which build it is serving.
 *
 * The page cannot tell on its own, and on a phone there is no console to ask
 * from. Shown beside the server's own build so the two can be compared —
 * which is the whole diagnostic, since a mismatch is exactly the state worth
 * recognising.
 */
export async function askVersion() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

  /*
   * There may be no controller yet.
   *
   * On the very load that registers the worker, the page is not controlled by
   * it — that starts at the next navigation. Asking then and giving up left
   * the version reading "—" on exactly the visit where someone had gone
   * looking for it. Waiting for ready and asking again costs nothing on the
   * loads that were already controlled.
   */
  let worker = navigator.serviceWorker.controller
  if (!worker) {
    const registration = await navigator.serviceWorker.ready.catch(() => null)
    worker = navigator.serviceWorker.controller ?? registration?.active ?? null
  }
  if (!worker) return

  const channel = new MessageChannel()
  channel.port1.onmessage = (event) => {
    if (event.data?.type === 'VERSION') shellVersion.set(event.data.version)
  }
  worker.postMessage({ type: 'VERSION' }, [channel.port2])
}
