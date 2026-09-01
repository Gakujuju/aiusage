// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest'

/**
 * The app starts.
 *
 * Everything else in this suite reads source text, which says what the code
 * is meant to do and nothing about whether it runs. That gap cost an
 * afternoon: onDestroy was called from inside onMount, which throws, and the
 * throw took the rest of that handler with it — including the call deciding
 * whether the reader is signed in. The app sat on "checking access" for
 * ever. svelte-check passed. pnpm build passed. Opening the page was the
 * only thing that noticed.
 *
 * Serving the page would not have noticed either: adapter-static builds a
 * single-page app, so GET / returns a shell containing no application
 * content at all — measured, zero matches for anything the app renders. That
 * HTML is identical whether the app boots or is completely broken.
 *
 * So this mounts the root layout for real and asks only whether it came up.
 * Not what it renders, not how it behaves — those change constantly and are
 * covered elsewhere. Just that the thing starts, because that is the failure
 * nothing else here can see.
 *
 * The layout rather than a page: it is the one component every screen goes
 * through, and it is where the fault was.
 *
 * $app/stores is aliased to a stub in vitest.config.ts. It has to resolve
 * when the component is compiled, which a mock cannot do.
 */

/*
 * Both stubs are installed before the component is imported, not in a hook.
 * The theme code asks matchMedia what the reader prefers as the module
 * loads, and jsdom does not provide one.
 */
vi.stubGlobal('matchMedia', () => ({
  matches: false,
  media: '',
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
}))

/** The API is not under test, and starting must not depend on a server. */
vi.stubGlobal('fetch', () => Promise.reject(new Error('offline in test')))

// Imported once: compiling the layout and its imports takes several seconds,
// and doing it per test spent the whole hook budget on the same work.
const Layout = (await import('../src/routes/+layout.svelte')).default

function mount() {
  const target = document.createElement('div')
  document.body.appendChild(target)
  return { target, app: new Layout({ target }) }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('the root layout comes up', () => {
  it('mounts without throwing', () => {
    // A lifecycle function called from inside a callback throws here, which
    // is exactly the failure this exists to catch.
    expect(() => mount()).not.toThrow()
  })

  it('renders something', () => {
    // Mounting can succeed while producing nothing, and an empty page is the
    // same outage from the reader's side.
    const { target } = mount()

    expect(target.innerHTML.trim().length).toBeGreaterThan(0)
  })

  it('tears down without throwing', () => {
    // The teardown path is where the fault was introduced, when the
    // registration for it was put in the wrong place.
    const { app } = mount()

    expect(() => app.$destroy()).not.toThrow()
  })
})
