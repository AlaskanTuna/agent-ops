import { existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { LEDGER_WINDOW_MS, nowIso, nowMs } from '../clock'
import { readEvents } from '../events'
import { dataDir } from '../paths'
import { reapStaleLeases } from '../reaper'
import { leasePath } from '../lease'
import { registerStep } from './index'

const DAY_MS = 24 * 3600 * 1000
const STRIP_AFTER_MS = 2 * 3600 * 1000
const REMOVE_AFTER_MS = 3 * DAY_MS

/** End time and root of every job in the ledger window, by job id. */
function jobEnds(): { at: Map<string, number>; roots: Map<string, string> } {
  const at = new Map<string, number>()
  const roots = new Map<string, string>()
  for (const e of readEvents(nowMs() - LEDGER_WINDOW_MS)) {
    if (typeof e.job !== 'string') continue
    if (e.event === 'job_start') roots.set(e.job, String(e.root ?? e.job))
    if (e.event === 'job_end') {
      const t = Date.parse(String(e.ts))
      if (Number.isFinite(t)) at.set(e.job, t)
    }
  }
  return { at, roots }
}

/** Remove git-ignored files from a worktree; true when anything was removed. */
function stripIgnored(path: string): boolean {
  if (!existsSync(join(path, '.git'))) return false
  const dry = Bun.spawnSync(['git', '-C', path, 'clean', '-ndX'], { stdout: 'pipe', stderr: 'ignore' })
  if (dry.exitCode !== 0 || dry.stdout.toString().trim() === '') return false
  const p = Bun.spawnSync(['git', '-C', path, 'clean', '-fdXq'], { stdout: 'ignore', stderr: 'ignore' })
  return p.exitCode === 0
}

function mtimeOf(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}

function olderThan(path: string, ageMs: number, now: number): boolean {
  const mtime = mtimeOf(path)
  if (mtime === undefined) return false
  return now - mtime > ageMs
}

function removeWorktree(path: string, top: string | undefined): boolean {
  if (top !== undefined) {
    try {
      const p = Bun.spawnSync(['git', '-C', top, 'worktree', 'remove', '--force', path], {
        stdout: 'ignore',
        stderr: 'ignore'
      })
      if (p.exitCode === 0) return true
      Bun.spawnSync(['git', '-C', top, 'worktree', 'prune'], { stdout: 'ignore', stderr: 'ignore' })
    } catch {
      // fall through to deleting the folder
    }
  }
  try {
    rmSync(path, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

function jobRoot(job: string): string | undefined {
  const events = readEvents(nowMs() - LEDGER_WINDOW_MS)
  const start = events.find((e) => e.event === 'job_start' && e.job === job)
  if (!start) return undefined
  return String(start.root ?? start.job)
}

function topOf(path: string): string | undefined {
  try {
    return readFileSync(`${path}.fanout-repo`, 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

function deleteRef(top: string, root: string): void {
  try {
    Bun.spawnSync(['git', '-C', top, 'update-ref', '-d', `refs/fanout/${root}`], {
      stdout: 'ignore',
      stderr: 'ignore'
    })
  } catch {
    // ref cleanup never breaks housekeeping
  }
}

function cleanDir(dir: string, ageMs: number, now: number, recursive: boolean): number {
  let removed = 0
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  for (const e of entries) {
    const path = join(dir, e)
    if (!olderThan(path, ageMs, now)) continue
    try {
      if (recursive) rmSync(path, { recursive: true, force: true })
      else unlinkSync(path)
      removed += 1
    } catch {
      // one bad entry never stops the sweep
    }
  }
  return removed
}

export async function runHousekeeping(): Promise<string> {
  const now = nowMs()
  const runDir = join(dataDir(), 'run')
  let before: string[] = []
  try {
    before = readdirSync(runDir).filter((f) => f.endsWith('.lease'))
  } catch {
    before = []
  }
  await reapStaleLeases()
  let after: string[] = []
  try {
    after = readdirSync(runDir).filter((f) => f.endsWith('.lease'))
  } catch {
    after = []
  }
  const leases = before.length - after.length

  let worktrees = 0
  const wtDir = join(dataDir(), 'worktrees')
  let entries: string[] = []
  try {
    entries = readdirSync(wtDir)
  } catch {
    entries = []
  }
  const touchedRoots = new Map<string, string | undefined>()
  const ends = jobEnds()
  let stripped = 0
  for (const e of entries) {
    if (e.endsWith('.fanout-repo')) continue
    const path = join(wtDir, e)
    const dash0 = e.lastIndexOf('-a')
    const job0 = dash0 >= 0 ? e.slice(0, dash0) : e
    const root0 = ends.roots.get(job0) ?? job0
    // A running chain's worktree is never touched.
    if (existsSync(leasePath(root0))) continue
    // Last activity: the job's end, or a later change to the folder itself.
    const ended = ends.at.get(job0)
    const last = Math.max(ended ?? 0, mtimeOf(path) ?? 0)
    if (last === 0) continue
    if (now - last <= REMOVE_AFTER_MS) {
      // Git-ignored files (node_modules, build output, caches) are never part
      // of the saved patch, so a finished worktree sheds them after 2 hours.
      if (ended !== undefined && now - ended > STRIP_AFTER_MS && stripIgnored(path)) stripped += 1
      continue
    }
    const top = topOf(path)
    if (removeWorktree(path, top)) worktrees += 1
    try {
      unlinkSync(`${path}.fanout-repo`)
    } catch {
      // the marker may never have existed
    }
    const dash = e.lastIndexOf('-a')
    const job = dash >= 0 ? e.slice(0, dash) : e
    const root = jobRoot(job)
    if (root !== undefined && !touchedRoots.has(root)) touchedRoots.set(root, top)
  }
  const remaining = new Set<string>()
  try {
    for (const e of readdirSync(wtDir)) {
      if (e.endsWith('.fanout-repo')) continue
      const dash = e.lastIndexOf('-a')
      const job = dash >= 0 ? e.slice(0, dash) : e
      const root = jobRoot(job)
      if (root !== undefined) remaining.add(root)
    }
  } catch {
    // without a listing every touched root is treated as fully removed
  }
  for (const [root, top] of touchedRoots) {
    if (remaining.has(root) || top === undefined) continue
    deleteRef(top, root)
  }

  const logs = cleanDir(join(dataDir(), 'logs'), 14 * DAY_MS, now, false)
  const patches = cleanDir(join(dataDir(), 'patches'), 30 * DAY_MS, now, false)
  const smoke = cleanDir(join(dataDir(), 'smoke'), 1 * DAY_MS, now, true)
  return `reaped ${leases} leases, stripped ${stripped} worktrees, removed ${worktrees} worktrees, deleted ${logs} logs, ${patches} patches, ${smoke} smoke dirs`
}

export function registerHousekeepingStep(): void {
  registerStep('housekeeping', async (ctx) => {
    const summary = await runHousekeeping()
    ctx.updateStatus({ last_housekeeping: nowIso() })
    return summary
  })
}
