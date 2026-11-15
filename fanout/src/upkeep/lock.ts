import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readStartTicks } from '../exec'
import { nowIso } from '../clock'
import { runDir } from '../paths'

export interface UpkeepLock {
  pid: number
  startTicks: number
  started: string
}

export function upkeepLockPath(): string {
  return join(runDir(), 'upkeep.lock')
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but belongs to another user: treat as alive.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

function lockLiveData(raw: string): boolean {
  let data: UpkeepLock
  try {
    data = JSON.parse(raw) as UpkeepLock
  } catch {
    return false
  }
  const pid = Number(data.pid)
  const ticks = Number(data.startTicks)
  if (!Number.isFinite(pid) || pid <= 0) return false
  if (!pidAlive(pid)) return false
  if (Number.isFinite(ticks) && ticks > 0) return readStartTicks(pid) === ticks
  return true
}

/** True when a live owner holds the upkeep lock. */
export function upkeepLockLive(): boolean {
  const path = upkeepLockPath()
  if (!existsSync(path)) return false
  try {
    return lockLiveData(readFileSync(path, 'utf8'))
  } catch {
    return false
  }
}

function writeLock(): void {
  const data: UpkeepLock = { pid: process.pid, startTicks: readStartTicks(process.pid), started: nowIso() }
  mkdirSync(runDir(), { recursive: true, mode: 0o700 })
  writeFileSync(upkeepLockPath(), JSON.stringify(data), { flag: 'wx', mode: 0o600 })
}

/**
 * Take the upkeep lock. A second upkeep exits at once while a live owner
 * holds it; a stale lock is taken over. Never throws.
 */
export function acquireUpkeepLock(): boolean {
  try {
    writeLock()
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') return false
  }
  let raw = ''
  try {
    raw = readFileSync(upkeepLockPath(), 'utf8')
  } catch {
    return false
  }
  if (lockLiveData(raw)) return false
  try {
    unlinkSync(upkeepLockPath())
  } catch {
    // another process may have taken it; the retry below decides
  }
  try {
    writeLock()
    return true
  } catch {
    return false
  }
}

export function releaseUpkeepLock(): void {
  try {
    if (existsSync(upkeepLockPath())) unlinkSync(upkeepLockPath())
  } catch {
    // lock cleanup never breaks upkeep
  }
}
