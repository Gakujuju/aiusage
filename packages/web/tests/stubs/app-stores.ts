import { readable } from 'svelte/store'

/**
 * Stands in for $app/stores when a component is mounted outside SvelteKit.
 *
 * The real one is produced by the framework at build time, so it cannot be
 * resolved by a plain Svelte compile. Only what the layout actually reads is
 * provided; anything else it grows a need for will fail loudly here rather
 * than quietly returning undefined.
 */

export const page = readable({
  url: new URL('http://localhost/'),
  params: {},
  route: { id: '/' },
  status: 200,
  error: null,
  data: {},
  form: null,
})

export const navigating = readable(null)
export const updated = Object.assign(readable(false), { check: async () => false })
