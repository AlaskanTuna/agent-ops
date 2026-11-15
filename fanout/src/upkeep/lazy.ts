import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { nowMs } from '../clock'
import { dataDir, usingFallbackDir } from '../paths'
import { readStatusJson } from './index'
import { upkeepLockLive } from './lock'

const DAY_MS = 24 * 3600 * 1000
const HOUR_MS = 3600 * 1000

function olderThan(value: unknown, ageMs: number, now: number): boolean {
  if (typeof value !== 'string') return true
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) return true
  return now - ms > ageMs
}

/**
 * Start `upkeep --lazy` detached when the last success is over 24 h old.
 * Never throws and never waits. Test seam: FANOUT_LAZY_LOG appends instead
 * of spawning.
 */
export async function maybeLazyUpkeep(): Promise<void> {
  try {
    if (process.env.FANOUT_NO_LAZY === '1') return
    if (usingFallbackDir()) return
    void dataDir()
    const st = readStatusJson()
    const now = nowMs()
    if (st !== undefined && !olderThan(st.last_upkeep_ok, DAY_MS, now)) return
    if (st !== undefined && !olderThan(st.last_upkeep_attempt, HOUR_MS, now)) return
    if (upkeepLockLive()) return
    const log = process.env.FANOUT_LAZY_LOG
    if (log) {
      appendFileSync(log, 'spawn upkeep --lazy\n')
      return
    }
    const script = process.argv[1]
    if (!script) return
    // Upkeep is a new top-level chain: a nested caller must not mark it nested.
    const { FANOUT_DEPTH: _depth, ...env } = process.env
    void _depth
    const child = spawn(process.execPath, [script, 'upkeep', '--lazy'], {
      env: { ...env },
      detached: true,
      stdio: 'ignore'
    })
    if (child.unref) child.unref()
  } catch {
    // the lazy trigger never breaks a command
  }
}
