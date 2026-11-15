import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface ProcessResult {
  exit: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface RunProcessOptions {
  cwd: string
  env: Record<string, string>
  timeoutS: number
  logOut: string
  logErr: string
}

export async function runProcess(argv: string[], o: RunProcessOptions): Promise<ProcessResult> {
  mkdirSync(dirname(o.logOut), { recursive: true, mode: 0o700 })
  mkdirSync(dirname(o.logErr), { recursive: true, mode: 0o700 })
  return new Promise((resolvePromise) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: o.cwd,
      env: o.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const decoder = new TextDecoder()
    child.stdout?.on('data', (d: Buffer) => {
      stdout += decoder.decode(d, { stream: true })
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += decoder.decode(d, { stream: true })
    })
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM')
        else child.kill('SIGTERM')
      } catch {
        // already gone
      }
    }, o.timeoutS * 1000)
    if (timer.unref) timer.unref()
    child.on('close', (code) => {
      clearTimeout(timer)
      stdout += decoder.decode()
      stderr += decoder.decode()
      try {
        writeFileSync(o.logOut, stdout, { mode: 0o600 })
      } catch {
        // log failures never break a run
      }
      try {
        writeFileSync(o.logErr, stderr, { mode: 0o600 })
      } catch {
        // log failures never break a run
      }
      resolvePromise({ exit: code, stdout, stderr, timedOut })
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolvePromise({ exit: null, stdout, stderr, timedOut })
    })
  })
}
