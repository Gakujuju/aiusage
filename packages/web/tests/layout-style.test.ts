import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const layoutSource = readFileSync(
  fileURLToPath(new URL('../src/routes/+layout.svelte', import.meta.url)),
  'utf8',
)

function getRule(selector: string): string {
  const match = layoutSource.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))
  return match?.[1] ?? ''
}

function hasDeclaration(rule: string, property: string, value: string): boolean {
  return new RegExp(`(^|;)\\s*${property}:\\s*${value}\\s*(;|$)`).test(rule)
}

describe('layout styles', () => {
  it('keeps public language toggle the same size for EN and Chinese labels', () => {
    const rule = getRule('.public-lang')

    expect(hasDeclaration(rule, 'width', '2.5rem')).toBe(true)
    expect(hasDeclaration(rule, 'min-width', '2.5rem')).toBe(true)
    expect(hasDeclaration(rule, 'padding', '0')).toBe(true)
  })
})

describe('a way in is always on screen', () => {
  /**
   * The public home page's only route to the login form used to be the brand
   * logo, which reads as decoration. A visitor whose figures were all coming
   * back 401 had a refresh button and nothing else.
   */
  it('gives the public home an explicit sign-in button', () => {
    expect(layoutSource).toContain('class="public-signin"')
    expect(layoutSource).toContain("$t('auth.signIn')")
    // Same handler as the brand button: one dialog, two ways to reach it.
    const button = layoutSource.match(/<button class="public-signin"[^>]*>/)?.[0] ?? ''
    expect(button).toContain('on:click={openUnlock}')
  })

  it('hides the back-to-home link when there is no public home', () => {
    // Otherwise it returns to the page you are already on.
    expect(layoutSource).toMatch(/\{#if publicHome\}[\s\S]*?class="auth-home"[\s\S]*?\{\/if\}/)
  })

  it('asks the server again when any request comes back 401', () => {
    // The session can lapse with the dashboard open. Without this the shell
    // keeps drawing as if logged in and every page fills with the same error.
    expect(layoutSource).toContain('setUnauthorizedHandler(onUnauthorized)')
    expect(layoutSource).toContain('setUnauthorizedHandler(null)')
  })

  it('does none of it when there is no password to enter', () => {
    const handler = layoutSource.match(/function onUnauthorized\(\)[\s\S]*?\n  \}/)?.[0] ?? ''
    expect(handler).toContain('!authEnabled')
  })
})
