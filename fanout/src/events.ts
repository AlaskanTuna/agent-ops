import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'
import { dataDir, usingFallbackDir } from './paths'

export type FanoutEvent = Record<string, unknown>

let warnedUnwritable = false

export function warnUnwritable(): void {
  if (warnedUnwritable) return
  warnedUnwritable = true
  try {
    console.error('WARN ledger unwritable; events not recorded')
  } catch {
    // warnings never break a run
  }
}

function monthFile(ts: string): string {
  const month = new Date(ts).toISOString().slice(0, 7)
  return join(dataDir(), 'events', `${month}.jsonl`)
}

/** True when a fresh probe file can be created in the events directory. */
export function ledgerWritable(): boolean {
  if (usingFallbackDir()) return false
  try {
    const dir = join(dataDir(), 'events')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // Unique per process: concurrent runs must never share a probe file.
    const probe = join(dir, `.writetest-${process.pid}-${Math.floor(Math.random() * 1e9)}`)
    writeFileSync(probe, '1', { mode: 0o600 })
    try {
      unlinkSync(probe)
    } catch {
      // the writability answer is already known; cleanup is best effort
    }
    return true
  } catch {
    return false
  }
}

/** Append one event. Returns false when the ledger is unwritable (fail open). */
export function appendEvent(event: FanoutEvent): boolean {
  if (usingFallbackDir()) {
    warnUnwritable()
    return false
  }
  try {
    const ts = typeof event.ts === 'string' ? event.ts : new Date().toISOString()
    const file = monthFile(ts)
    mkdirSync(join(dataDir(), 'events'), { recursive: true, mode: 0o700 })
    const line = JSON.stringify(event) + '\n'
    const fd = openSync(file, 'a', 0o600)
    try {
      const buf = Buffer.from(line, 'utf8')
      let off = 0
      while (off < buf.length) off += writeSync(fd, buf, off)
    } finally {
      closeSync(fd)
    }
    return true
  } catch (err) {
    warnUnwritable()
    try {
      mkdirSync(dataDir(), { recursive: true, mode: 0o700 })
      appendFileSync(join(dataDir(), 'errors.log'), `${new Date().toISOString()} appendEvent: ${String(err)}\n`)
    } catch {
      // never throws
    }
    return false
  }
}

export function readEvents(sinceMs: number): FanoutEvent[] {
  const dir = join(dataDir(), 'events')
  if (!existsSync(dir)) return []
  const out: FanoutEvent[] = []
  let files: string[] = []
  try {
    files = readdirSync(dir)
  } catch {
    return []
  }
  for (const f of files.sort()) {
    if (!f.endsWith('.jsonl')) continue
    let text = ''
    try {
      text = readFileSync(join(dir, f), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as FanoutEvent
        if (typeof e.v === 'number' && e.v > 1) continue
        const ts = Date.parse(String(e.ts))
        if (Number.isNaN(ts) || ts < sinceMs) continue
        out.push(e)
      } catch {
        // corrupt lines are skipped
      }
    }
  }
  return out
}
