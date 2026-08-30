import { describe, it, expect, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { readSecretLine, normalizeSecret } from '../src/secret-input.js'

/**
 * The EOF-based reader this replaces could not be completed by hand on
 * Windows — Ctrl+Z did nothing in PowerShell — so the only way to set a
 * secret was piping from echo, which is exactly the exposure stdin was
 * chosen to avoid.
 */
const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin')!

function pipe(text: string) {
  const stream = Readable.from([Buffer.from(text)]) as unknown as NodeJS.ReadStream
  // Piped input, so no TTY and no masking.
  Object.defineProperty(stream, 'isTTY', { value: undefined, configurable: true })
  Object.defineProperty(process, 'stdin', { value: stream, configurable: true })
}

afterEach(() => {
  Object.defineProperty(process, 'stdin', realStdin)
})

describe('readSecretLine', () => {
  it('reads one piped line', async () => {
    pipe('hunter2\n')
    expect(await readSecretLine('prompt: ')).toBe('hunter2')
  })

  it('reads a line with no trailing newline', async () => {
    // `echo -n` and several shells produce this.
    pipe('hunter2')
    expect(await readSecretLine('prompt: ')).toBe('hunter2')
  })

  it('takes only the first line when more arrive', async () => {
    // A stray second line must not silently become part of the secret.
    pipe('first-line\nsecond-line\nthird\n')
    expect(await readSecretLine('prompt: ')).toBe('first-line')
  })

  it('handles CRLF, which is what Windows pipes produce', async () => {
    pipe('hunter2\r\n')
    expect(await readSecretLine('prompt: ')).toBe('hunter2')
  })

  it('keeps spaces inside and around the secret', async () => {
    // A password may legitimately start or end with a space; changing what
    // was typed without saying so is worse than accepting it.
    pipe('  spaced secret  \n')
    expect(await readSecretLine('prompt: ')).toBe('  spaced secret  ')
  })

  it('returns empty for an empty line, so the caller can refuse it', async () => {
    pipe('\n')
    expect(await readSecretLine('prompt: ')).toBe('')
  })

  it('returns empty for a stream that closes with nothing in it', async () => {
    pipe('')
    expect(await readSecretLine('prompt: ')).toBe('')
  })

  it('does not print the prompt when input is piped', async () => {
    const written: string[] = []
    const write = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: any) => { written.push(String(chunk)); return true }) as any
    try {
      pipe('hunter2\n')
      await readSecretLine('SHOULD-NOT-APPEAR: ')
    } finally {
      process.stdout.write = write
    }
    expect(written.join('')).not.toContain('SHOULD-NOT-APPEAR')
  })
})

describe('normalizeSecret', () => {
  it('drops only the trailing newline', () => {
    expect(normalizeSecret('secret\n')).toBe('secret')
    expect(normalizeSecret('secret\r\n')).toBe('secret')
    expect(normalizeSecret('  secret  ')).toBe('  secret  ')
    expect(normalizeSecret('a\nb\n')).toBe('a\nb')
  })
})
