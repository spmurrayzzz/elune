import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function prepareWindowsStorage(databasePath) {
  const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = readFileSync(new URL('./windows-storage.ps1', import.meta.url), 'utf8')
  try {
    execFileSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      input: Buffer.from(databasePath, 'utf8').toString('base64'),
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH')),
      encoding: 'utf8',
      timeout: 7000,
      maxBuffer: 65536,
      windowsHide: true,
    })
  } catch (error) {
    throw new Error(`Windows trace storage permissions failed: ${error.stderr?.trim() || error.message}`, { cause: error })
  }
}
