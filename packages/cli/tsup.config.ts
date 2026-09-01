import { defineConfig } from 'tsup'
import { execSync } from 'node:child_process'

/** Asks git, and shrugs if it is not there rather than failing the build. */
function gitOrNull(args: string): string | null {
  try {
    return execSync(`git ${args}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}
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
      /*
       * Which commit this build is, and when that commit was made.
       *
       * Both, because neither answers the question alone. The hash says
       * whether two machines are running the same code and nothing about
       * which is older; the time orders them but cannot tell one commit
       * from another made in the same second. The package version does not
       * change per commit at all, and a build timestamp differs between two
       * machines that built the very same code.
       *
       * Missing when git is not there, and that stays "unknown" rather than
       * becoming "out of date" — the same rule as a spoke that has never
       * reported in.
       */
      __COMMIT__: JSON.stringify(gitOrNull('rev-parse --short HEAD')),
      __COMMIT_TIME__: JSON.stringify(
        Number(gitOrNull('log -1 --format=%ct')) || null),
    }
  },
})
