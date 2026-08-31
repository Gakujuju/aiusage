import { describe, it, expect } from 'vitest'
import { createHubUploadReporter } from '../../src/commands/serve.js'
import type { HubUploadResult } from '../../src/sync/hub-upload.js'

/**
 * A spoke that nobody has used yet has nothing to upload, and silence is what
 * a misconfigured hub looks like too. The setup check cannot tell them apart
 * without being told — but told once, not every twenty minutes for as long as
 * the machine is idle.
 */

const nothingToSend: HubUploadResult = { sent: 0, batches: 0, skipped: 'nothing_to_send' }

function reporter(results: HubUploadResult[]) {
  const logs: string[] = []
  const warns: string[] = []
  let call = 0
  const run = createHubUploadReporter(
    async () => results[Math.min(call++, results.length - 1)],
    (m) => logs.push(m),
    (m) => warns.push(m),
  )
  return { run, logs, warns }
}

describe('hub upload reporting', () => {
  it('says "nothing to upload" once, however many passes find nothing', async () => {
    const { run, logs } = reporter([nothingToSend])

    await run()
    await run()
    await run()

    expect(logs).toEqual(['[serve] hub configured; nothing to upload yet (no unsent records)'])
  })

  it('says nothing at all when there is no hub', async () => {
    const { run, logs, warns } = reporter([{ sent: 0, batches: 0, skipped: 'no_hub' }])

    await run()
    await run()

    // The ordinary single-machine install takes this path on every parse.
    expect(logs).toEqual([])
    expect(warns).toEqual([])
  })

  it('reports every upload that actually sent something', async () => {
    const { run, logs } = reporter([
      { sent: 3, batches: 1, skipped: null },
      { sent: 7, batches: 1, skipped: null },
    ])

    await run()
    await run()

    expect(logs).toEqual([
      '[serve] uploaded 3 record(s) to the hub',
      '[serve] uploaded 7 record(s) to the hub',
    ])
  })

  it('reports every failure, because each one is a fresh problem', async () => {
    const { run, logs, warns } = reporter([
      { sent: 0, batches: 0, skipped: null, error: 'HTTP 401' },
    ])

    await run()
    await run()

    expect(warns).toEqual([
      '[serve] hub upload failed: HTTP 401',
      '[serve] hub upload failed: HTTP 401',
    ])
    expect(logs).toEqual([])
  })

  /**
   * The flag belongs to the reporter, not the module: two serves in one
   * process — which is what a test file is — must not silence each other.
   */
  it('gives each reporter its own state', async () => {
    const first = reporter([nothingToSend])
    const second = reporter([nothingToSend])

    await first.run()
    await second.run()

    expect(first.logs).toHaveLength(1)
    expect(second.logs).toHaveLength(1)
  })

  it('still announces a later upload after having said nothing to send', async () => {
    const { run, logs } = reporter([nothingToSend, { sent: 2, batches: 1, skipped: null }])

    await run()
    await run()

    expect(logs).toEqual([
      '[serve] hub configured; nothing to upload yet (no unsent records)',
      '[serve] uploaded 2 record(s) to the hub',
    ])
  })
})
