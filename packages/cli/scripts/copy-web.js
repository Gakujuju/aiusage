#!/usr/bin/env node
// Copies the web SPA build into the CLI dist so it ships inside the npm package.
import { cpSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const webBuildDir = join(__dirname, '..', '..', 'web', 'build')
const destDir = join(__dirname, '..', 'dist', 'web')

if (!existsSync(webBuildDir)) {
  /*
   * A warning, so that building the CLI alone is a supported thing to do.
   *
   * Machines that serve no screen should not have to build one. What must
   * not happen is silence: the copy is skipped, so whatever is in dist/web
   * stays exactly as it was, and saying which is the difference between an
   * old screen and a mystery.
   */
  console.warn('Web build not found at', webBuildDir)
  console.warn('Skipping the copy: dist/web has NOT been updated.')
  console.warn('If this machine serves the dashboard, run: pnpm --filter @aiusage/web build')
  process.exit(0)
}

/*
 * Removed only once there is something to put back.
 *
 * Deleting first meant any failure between the two left no dashboard at
 * all, which is how production served 404s twice in one day.
 */
if (existsSync(destDir)) {
  rmSync(destDir, { recursive: true })
}

cpSync(webBuildDir, destDir, { recursive: true })
console.log('Web build copied to dist/web')
