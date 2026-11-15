import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readStartTicks } from './exec'
import { nowIso } from './clock'
import { runDir } from './paths'

export interface LeaseData {
  root: string
  job: string
  pid: number
  startTicks: number
  pgid: number
  workerTicks: number
  harness: string
  model: string
  started: string
  heartbeat: string
}

export interface Lease {
  data: LeaseData
  update(patch: Partial<LeaseData>): void
  release(): void
}

export function leasePath(root: string): string {
  return join(runDir(), `${root}.lease`)
}

function writeLeaseFile(path: string, data: LeaseData): void {
  mkdirSync(runDir(), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(data), { mode: 0o600 })
}

export function acquireLease(root: string): Lease {
  const started = nowIso()
  const path = leasePath(root)
  const data: LeaseData = {
    root,
    job: root,
    pid: process.pid,
    startTicks: readStartTicks(process.pid),
    pgid: 0,
    workerTicks: 0,
    harness: '',
    model: '',
    started,
    heartbeat: started
  }
  try {
    writeLeaseFile(path, data)
  } catch {
    // lease failures never break a run
  }
  const hb = setInterval(() => {
    data.heartbeat = nowIso()
    try {
      writeLeaseFile(path, data)
    } catch {
      // ignore
    }
  }, 15000)
  if (hb.unref) hb.unref()
  return {
    data,
    update(patch: Partial<LeaseData>): void {
      Object.assign(data, patch)
      try {
        writeLeaseFile(path, data)
      } catch {
        // ignore
      }
    },
    release(): void {
      clearInterval(hb)
      try {
        if (existsSync(path)) unlinkSync(path)
      } catch {
        // ignore
      }
    }
  }
}
