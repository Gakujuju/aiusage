import { defineConfig } from 'tsup'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  /*
   * clean wipes dist, and dist/web is the dashboard serve reads from disk on
   * every request. Running tsup on its own therefore took the production
   * dashboard down to a 404 while the process stayed up and healthy — twice,
   * once documented and once repeated anyway.
   *
   * The copy is part of the build rather than a step to remember, because
   * "remember to also run copy-web" is the instruction that failed both
   * times. `npm run build` still chains it too; this makes the bare `npx
   * tsup` safe as well.
   */
  clean: true,
  onSuccess: 'node scripts/copy-web.js',
  noExternal: ['@aiusage/core'],
  esbuildOptions(options) {
    options.define = {
      ...options.define,
      __VERSION__: JSON.stringify(pkg.version),
    }
  },
})
