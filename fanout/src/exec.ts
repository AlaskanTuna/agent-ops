import { spawn } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, writeSync, closeSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Adapter, BuiltCommand } from './adapters/types'

export interface ProcessResult {
  exit: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface SpawnInfo {
  pid: number
  pgid: number
}

export interface RunProcessOptions {
  cwd: string
  env: Record<string, string>
  timeoutS: number
  logOut: string
  logErr: string
  stdinPath?: string
  stdinText?: string
  onSpawn?: (info: SpawnInfo) => void
}

const STDOUT_TAIL = 256 * 1024
const STDERR_TAIL = 64 * 1024

const ALLOW = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TZ',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy'
]

export function readStartTicks(pid: number): number {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const idx = text.lastIndexOf(')')
    if (idx < 0) return 0
    const fields = text
      .slice(idx + 1)
      .trim()
      .split(/\s+/)
    const ticks = Number(fields[19])
    return Number.isFinite(ticks) ? ticks : 0
  } catch {
    return 0
  }
}

export function killGroup(pgid: number, sig: NodeJS.Signals = 'SIGTERM'): void {
  try {
    if (process.platform !== 'win32' && pgid > 0) process.kill(-pgid, sig)
  } catch {
    // already gone
  }
}

export function workerEnv(adapter: Adapter, built: BuiltCommand): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of ALLOW) {
    const v = process.env[k]
    if (v !== undefined) env[k] = v
  }
  for (const pat of adapter.envAllow ?? []) {
    if (pat.endsWith('*')) {
      const pre = pat.slice(0, -1)
      for (const [k, v] of Object.entries(process.env)) {
        if (k.startsWith(pre) && v !== undefined) env[k] = v
      }
    } else {
      const v = process.env[pat]
      if (v !== undefined) env[pat] = v
    }
  }
  for (const [k, v] of Object.entries(built.env)) {
    if (v === null) delete env[k]
    else env[k] = v
  }
  const depthRaw = Number.parseInt(process.env.FANOUT_DEPTH ?? '0', 10)
  env.FANOUT_DEPTH = String((Number.isFinite(depthRaw) ? depthRaw : 0) + 1)
  return env
}

export async function runProcess(argv: string[], o: RunProcessOptions): Promise<ProcessResult> {
  mkdirSync(dirname(o.logOut), { recursive: true, mode: 0o700 })
  mkdirSync(dirname(o.logErr), { recursive: true, mode: 0o700 })
  return new Promise((resolvePromise) => {
    let outFd = -1
    let errFd = -1
    try {
      outFd = openSync(o.logOut, 'w', 0o600)
      errFd = openSync(o.logErr, 'w', 0o600)
    } catch {
      // log failures never break a run
    }
    // The brief reaches the worker on stdin when the adapter asks for it: a file is passed as the fd itself,
    // text is written to a pipe. Otherwise stdin is closed.
    let inFd = -1
    if (o.stdinPath !== undefined) {
      try {
        inFd = openSync(o.stdinPath, 'r')
      } catch {
        inFd = -1
      }
    }
    const stdinMode = inFd >= 0 ? inFd : o.stdinText !== undefined ? 'pipe' : 'ignore'
    const child = spawn(argv[0], argv.slice(1), {
      cwd: o.cwd,
      env: o.env,
      detached: process.platform !== 'win32',
      stdio: [stdinMode, 'pipe', 'pipe']
    })
    if (inFd >= 0) {
      try {
        closeSync(inFd)
      } catch {
        // ignore
      }
    }
    if (o.stdinText !== undefined && child.stdin) {
      child.stdin.on('error', () => {})
      child.stdin.end(o.stdinText)
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let done = false
    const timers: ReturnType<typeof setTimeout>[] = []
    const finish = (exit: number | null) => {
      if (done) return
      done = true
      for (const t of timers) clearTimeout(t)
      if (outFd >= 0) {
        try {
          closeSync(outFd)
        } catch {
          // ignore
        }
      }
      if (errFd >= 0) {
        try {
          closeSync(errFd)
        } catch {
          // ignore
        }
      }
      resolvePromise({ exit, stdout, stderr, timedOut })
    }
    const decoder = new TextDecoder()
    child.stdout?.on('data', (d: Buffer) => {
      if (outFd >= 0) {
        try {
          writeSync(outFd, d)
        } catch {
          // ignore
        }
      }
      stdout = (stdout + decoder.decode(d, { stream: true })).slice(-STDOUT_TAIL)
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (errFd >= 0) {
        try {
          writeSync(errFd, d)
        } catch {
          // ignore
        }
      }
      stderr = (stderr + decoder.decode(d, { stream: true })).slice(-STDERR_TAIL)
    })
    if (child.pid) {
      try {
        o.onSpawn?.({ pid: child.pid, pgid: child.pid })
      } catch {
        // observer errors never break a run
      }
    }
    const pgid = child.pid ?? 0
    const timer = setTimeout(() => {
      timedOut = true
      killGroup(pgid, 'SIGTERM')
      const sigkill = setTimeout(() => killGroup(pgid, 'SIGKILL'), 5000)
      if (sigkill.unref) sigkill.unref()
      timers.push(sigkill)
    }, o.timeoutS * 1000)
    if (timer.unref) timer.unref()
    timers.push(timer)
    child.on('close', (code) => {
      finish(code)
    })
    child.on('error', () => {
      finish(null)
    })
  })
}
