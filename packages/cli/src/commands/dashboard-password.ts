import {
  DASHBOARD_PASSWORD_CREDENTIAL,
  loadCredential,
  saveCredential,
} from '../config.js'
import { readSecretLine, normalizeSecret } from '../secret-input.js'

/**
 * Set or inspect the dashboard password.
 *
 * Read from stdin rather than argv for the same reason the webhook is: an
 * argument is in the shell history, the process list, and any terminal
 * recording, and this one guards a page that is about to be reachable from
 * another machine. One line ended with Enter, masked when a person is
 * typing it — see readSecretLine for why EOF was the wrong contract.
 */

export interface DashboardPasswordResult {
  configured: boolean
  saved: boolean
  error?: string
}

/** The shortest password worth calling one on a network-reachable page. */
const MIN_LENGTH = 8

export async function runSetDashboardPassword(): Promise<DashboardPasswordResult> {
  const password = normalizeSecret(await readSecretLine('Dashboard password: '))

  if (!password) {
    console.error('Nothing was entered. The password is unchanged.')
    return { configured: loadCredential(DASHBOARD_PASSWORD_CREDENTIAL) != null, saved: false, error: 'empty' }
  }
  if (password.length < MIN_LENGTH) {
    console.error(`Too short — use at least ${MIN_LENGTH} characters. Nothing was saved.`)
    return { configured: loadCredential(DASHBOARD_PASSWORD_CREDENTIAL) != null, saved: false, error: 'too short' }
  }

  saveCredential(DASHBOARD_PASSWORD_CREDENTIAL, password)
  // Never the value, here or anywhere else.
  console.log('Dashboard password saved to ~/.aiusage/config.json (mode 0600).')
  console.log('Restart `aiusage serve` for it to take effect.')
  return { configured: true, saved: true }
}

export function runDashboardPasswordStatus(): DashboardPasswordResult {
  const fromEnv = process.env.AIUSAGE_DASHBOARD_PASSWORD?.trim()
  const stored = loadCredential(DASHBOARD_PASSWORD_CREDENTIAL)

  if (fromEnv) {
    console.log('Dashboard password: set via AIUSAGE_DASHBOARD_PASSWORD (this wins over the stored one).')
  } else if (stored) {
    console.log('Dashboard password: set in ~/.aiusage/config.json.')
  } else {
    console.log('Dashboard password: not set.')
    console.log('serve refuses a non-loopback bind without one. Set it with:')
    console.log('  aiusage set-dashboard-password')
  }
  return { configured: Boolean(fromEnv || stored), saved: false }
}
