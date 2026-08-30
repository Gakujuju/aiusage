import type Database from 'better-sqlite3'
import { renderDiscordContent } from '@aiusage/core'
import { hostname } from 'node:os'
import { randomBytes } from 'node:crypto'
import { AIUSAGE_DIR, DISCORD_WEBHOOK_CREDENTIAL, loadConfig, loadCredential, saveCredential } from '../config.js'
import { readSecretLine, normalizeSecret } from '../secret-input.js'
import { getState } from '../init.js'
import { enqueueNotification, summariseNotifications } from '../db/notifications.js'
import { maskUrls, postToDiscord } from '../notify/discord.js'
import type { NotificationRow } from '../db/notifications.js'

/**
 * `aiusage notify-test` and `aiusage notify-status`.
 *
 * notify-test sends directly rather than queueing, because the question it
 * answers is "does the webhook work", and routing through the outbox would
 * make the answer depend on serve running.
 */

const MIGRATION_STEPS = `
既存の PowerShell 通知からの移行手順:

  段階1  notifications.enabled は false のまま、webhook を設定して
         aiusage notify-test で疎通を確認する。既存通知はそのまま動く。
  段階2  notifications.enabled = true、notifierDevice = true にして併走。
         prefix '[aiusage] ' が付くので、既存通知と見分けられる。
         内容とタイミングが一致するか数日ぶん見比べる。
  段階3  一致を確認したら ~/.claude/settings.json から
         discord-notify.ps1 / stop-discord-notify.ps1 の呼び出しを外す。
         start-task-timer.ps1 と task-times/ もこの時点で不要になる
         （agent_session_spans が全ターン・全状態を保持している）。
         削除は別タスクとして行う。
`.trim()

export interface NotifyTestResult {
  webhookConfigured: boolean
  enabled: boolean
  notifierDevice: boolean
  sent: boolean
  error: string | null
}

export async function runNotifyTest(options: { setWebhook?: boolean } = {}): Promise<NotifyTestResult> {
  if (options.setWebhook) {
    // Same reader as the dashboard password: one line, Enter, masked when
    // typed. The EOF-based version could not be completed at all in
    // PowerShell, which left piping from echo as the only route — putting
    // the URL in the shell history, which is what stdin was meant to avoid.
    // A URL has no meaningful leading or trailing whitespace, so it is
    // trimmed; a password is not.
    const url = normalizeSecret(await readSecretLine('Discord webhook URL: ')).trim()
    if (!/^https:\/\/\S+$/.test(url)) {
      console.error('That does not look like an https URL. Nothing was saved.')
      return { webhookConfigured: false, enabled: false, notifierDevice: false, sent: false, error: 'invalid url' }
    }
    saveCredential(DISCORD_WEBHOOK_CREDENTIAL, url)
    console.log('Webhook saved to ~/.aiusage/config.json (mode 0600).')
    console.log('')
  }

  const config = loadConfig()
  const webhook = loadCredential(DISCORD_WEBHOOK_CREDENTIAL)
  const device = config?.device || hostname() || 'unknown'
  const prefix = config?.notifications?.prefix ?? '[aiusage] '

  const result: NotifyTestResult = {
    webhookConfigured: webhook != null,
    enabled: config?.notifications?.enabled === true,
    notifierDevice: config?.notifications?.notifierDevice === true,
    sent: false,
    error: null,
  }

  console.log(`Webhook configured : ${result.webhookConfigured ? 'yes' : 'no'}`)
  console.log(`Notifications      : ${result.enabled ? 'enabled' : 'disabled'}`)
  console.log(`Notifier device    : ${result.notifierDevice ? 'yes' : 'no'}`)
  console.log('')

  if (!webhook) {
    console.log('No webhook set. Store one with either:')
    // Read from stdin rather than argv so the URL never lands in shell history.
    console.log('  aiusage notify-test --set-webhook     (paste the URL, then Enter)')
    console.log(`  or add credentials.${DISCORD_WEBHOOK_CREDENTIAL} to ~/.aiusage/config.json`)
    console.log('')
    console.log(MIGRATION_STEPS)
    result.error = 'webhook not configured'
    return result
  }

  const message = {
    title: `${prefix}✅ ${device}｜通知テスト`,
    body: 'aiusage から Discord への疎通確認です。',
  }
  console.log('Sending:')
  console.log(renderDiscordContent(message).split('\n').map((l) => `  ${l}`).join('\n'))
  console.log('')

  // A test bypasses the queue: it should work, or say why, without needing
  // serve to be running.
  const outcome = await postToDiscord(webhook, {
    id: 'notify-test',
    title: message.title,
    body: message.body,
  } as NotificationRow)

  if (outcome.ok) {
    console.log('Sent.')
    result.sent = true
  } else {
    // Already masked by postToDiscord; masked again in case a caller changes.
    console.error(`Failed: ${maskUrls(outcome.error ?? 'unknown error')}`)
    result.error = maskUrls(outcome.error ?? 'unknown error')
  }

  if (!result.enabled) {
    console.log('')
    console.log('Notifications are still disabled, so nothing else will be sent.')
    console.log(MIGRATION_STEPS)
  }
  return result
}

export function runNotifyStatus(db: Database.Database): void {
  const summary = summariseNotifications(db, Date.now())
  const config = loadConfig()

  console.log(`Notifications : ${config?.notifications?.enabled === true ? 'enabled' : 'disabled'}`)
  console.log(`Notifier device: ${config?.notifications?.notifierDevice === true ? 'yes' : 'no'}`)
  console.log(`Webhook set   : ${loadCredential(DISCORD_WEBHOOK_CREDENTIAL) != null ? 'yes' : 'no'}`)
  console.log('')

  const states = Object.entries(summary.stateCounts)
  if (states.length === 0) {
    console.log('Outbox is empty.')
    return
  }
  console.log('Outbox:')
  for (const [state, count] of states.sort()) {
    console.log(`  ${state.padEnd(8)} ${count}`)
  }

  if (summary.recentFailures.length > 0) {
    console.log('')
    console.log('Recent failures:')
    for (const failure of summary.recentFailures) {
      console.log(`  ${failure.eventType} (${failure.attempts} attempts): ${failure.lastError}`)
    }
  }
}

/** Queue a test through the outbox, for exercising the sender end to end. */
export function enqueueTestNotification(db: Database.Database): boolean {
  const config = loadConfig()
  const device = config?.device || hostname() || 'unknown'
  const prefix = config?.notifications?.prefix ?? '[aiusage] '
  return enqueueNotification(db, {
    eventType: 'test',
    subjectKind: 'system',
    subjectId: 'test',
    dedupeKey: `test:${Date.now()}:${randomBytes(4).toString('hex')}`,
    title: `${prefix}✅ ${device}｜通知テスト`,
    body: 'aiusage から Discord への疎通確認です。',
    deviceInstanceId: getState(AIUSAGE_DIR)?.deviceInstanceId ?? '',
    drop: config?.notifications?.notifierDevice !== true,
  }, Date.now())
}

export { MIGRATION_STEPS }
