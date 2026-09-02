import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

/*
 * Here only so svelte-check can find the preprocessor.
 *
 * vite.config.ts sets `root: 'src/renderer'`, so a checker started at the
 * package root does not see the svelte plugin and refuses every component.
 * The build still reads vite.config.ts; this file exists for the check.
 */
export default { preprocess: vitePreprocess() }
