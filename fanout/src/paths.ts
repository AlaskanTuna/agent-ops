import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export function homeDir(): string {
  return process.env.HOME ?? homedir()
}

let resolvedDir: string | undefined
let fallbackDir = false

function processUid(): string {
  try {
    const getuid = (process as { getuid?: () => number }).getuid
    if (typeof getuid === 'function') return String(getuid.call(process))
  } catch {
    // fall through to the placeholder
  }
  return 'x'
}

function writableDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // Unique per process: concurrent runs must never share a probe file, or
    // one run's unlink makes another run's probe fail and misfire the fallback.
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

export function dataDir(): string {
  if (resolvedDir) return resolvedDir
  const primary = process.env.FANOUT_HOME ?? join(homeDir(), '.local', 'share', 'agent-ops', 'fanout')
  if (writableDir(primary)) {
    resolvedDir = primary
    return resolvedDir
  }
  // Fail open: the worker still runs, with logs, leases, worktrees and
  // patches under a temp dir. The ledger stays empty (see events.ts).
  fallbackDir = true
  resolvedDir = join(process.env.TMPDIR ?? tmpdir(), `fanout-${processUid()}`)
  try {
    mkdirSync(resolvedDir, { recursive: true, mode: 0o700 })
  } catch {
    // callers already tolerate unwritable paths
  }
  return resolvedDir
}

/** True when the primary data directory was unusable and the temp fallback is in effect. */
export function usingFallbackDir(): boolean {
  void dataDir()
  return fallbackDir
}

export function privateCatalogPath(): string {
  return join(homeDir(), '.config', 'agent-ops', 'catalog.csv')
}

export function autoCatalogPath(): string {
  return join(dataDir(), 'learned', 'catalog.auto.json')
}

export function runDir(): string {
  return join(dataDir(), 'run')
}

export function catalogOverridePath(): string | undefined {
  return process.env.FANOUT_CATALOG_FILE || undefined
}
