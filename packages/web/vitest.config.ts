import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * A config of its own, because vite.config.ts is for the app.
 *
 * That one uses sveltekit(), which expects the framework's dev-server
 * lifecycle around it and simply hangs when vitest imports a component. The
 * plain Svelte plugin compiles the same components without any of that.
 *
 * Most tests here read source text and need none of this. One mounts the
 * root layout to check the app actually starts — the failure that source
 * reading cannot see, and that a served page cannot either, since this is a
 * single-page app whose HTML contains no application content.
 */
export default defineConfig({
  plugins: [svelte({ hot: false })],
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
      // Produced by SvelteKit at build time, so a plain Svelte compile
      // cannot resolve it. The stub carries only what the layout reads.
      '$app/stores': fileURLToPath(new URL('./tests/stubs/app-stores.ts', import.meta.url)),
    },
    // Svelte ships a browser build; the mounting test runs in jsdom and needs
    // it rather than the server-side render path.
    conditions: ['browser'],
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
