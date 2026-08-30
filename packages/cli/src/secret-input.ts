import { createInterface } from 'node:readline'

/**
 * Read one secret from stdin.
 *
 * Reading to EOF and telling the user to press Ctrl+Z looked reasonable and
 * does not work: on Windows, Ctrl+Z in PowerShell prints `^Z` and nothing
 * happens, and cmd.exe ignores it here too. The only way through was piping
 * from `echo`, which puts the secret in the command line, on screen, and in
 * the shell history — and a placeholder got pasted and saved for real that
 * way. One line, terminated by Enter, is what people actually expect.
 *
 * Piped input goes through the same path: the first line arrives, and the
 * stream closing right after does not race the resolve.
 *
 * @param prompt shown only when stdin is a terminal
 */
export function readSecretLine(prompt: string): Promise<string> {
  const isTty = process.stdin.isTTY === true

  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      // A terminal-mode interface is what makes per-keystroke echo (and so
      // suppressing it) possible. For a pipe there is nothing to echo.
      output: isTty ? process.stdout : undefined,
      terminal: isTty,
    })

    if (isTty) {
      // readline echoes each keystroke through this; replacing it with a
      // mask is the documented way to keep the characters off the screen
      // while still showing that typing is registering.
      const muted = rl as unknown as { _writeToOutput: (text: string) => void }
      let promptShown = false
      muted._writeToOutput = (text: string) => {
        if (!promptShown) {
          process.stdout.write(prompt)
          promptShown = true
          return
        }
        // Backspace and the final newline still have to reach the terminal,
        // or editing and the line break stop working.
        if (text === '\r\n' || text === '\n') {
          process.stdout.write('\n')
          return
        }
        if (text.includes('\x7f') || text.includes('\b')) {
          process.stdout.write(text)
          return
        }
        process.stdout.write('*'.repeat(text.length))
      }
      rl.setPrompt(prompt)
      rl.prompt()
    }

    let settled = false
    const finish = (value: string) => {
      if (settled) return
      settled = true
      rl.close()
      resolve(value)
    }

    // Only the first line. Anything after it is discarded rather than
    // concatenated, so a stray second line cannot silently become part of
    // the secret.
    rl.once('line', (line) => finish(line))
    // A pipe that ends without a newline still has to produce its content.
    rl.once('close', () => finish(''))
  })
}

/**
 * The trailing newline goes; nothing else does.
 *
 * A password may legitimately begin or end with a space, and trimming it
 * would save something the user did not type without saying so.
 */
export function normalizeSecret(line: string): string {
  return line.replace(/\r?\n$/, '')
}
