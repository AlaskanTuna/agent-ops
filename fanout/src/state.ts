import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readStartTicks } from './exec'
import { readEvents } from './events'
import { runDir } from './paths'
import { LEDGER_WINDOW_MS } from './clock'

export interface Cooldown {
  until: number
  outcome: string
  scope: 'model' | 'account'
  source: string
}

export interface State {
  now: number
  cooldowns: Map<string, Cooldown>
  halfOpen: Map<string, { until: number; outcome: string; source: string }>
}

const WINDOW_MS = LEDGER_WINDOW_MS

export function cooldownKey(harness: string, model: string, scope: 'model' | 'account'): string {
  return scope === 'account' ? `${harness}/*` : `${harness}/${model}`
}

export function readState(now: number): State {
  const events = readEvents(now - WINDOW_MS)
  const latest = new Map<
    string,
    { ts: number; until: number; outcome: string; scope: 'model' | 'account'; source: string }
  >()
  const okModel = new Map<string, number>()
  const okHarness = new Map<string, number>()
  for (const e of events) {
    if (e.event === 'job_end' && e.outcome === 'ok') {
      const harness = typeof e.harness === 'string' ? e.harness : ''
      const model = typeof e.model === 'string' ? e.model : ''
      const ts = Date.parse(String(e.ts))
      if (!harness || Number.isNaN(ts)) continue
      if (model) {
        const key = `${harness}/${model}`
        if (ts > (okModel.get(key) ?? -Infinity)) okModel.set(key, ts)
      }
      if (ts > (okHarness.get(harness) ?? -Infinity)) okHarness.set(harness, ts)
      continue
    }
    if (e.event !== 'limit_hit') continue
    const harness = typeof e.harness === 'string' ? e.harness : ''
    const model = typeof e.model === 'string' ? e.model : ''
    if (!harness || !model) continue
    const scope = e.scope === 'account' ? 'account' : 'model'
    const ts = Date.parse(String(e.ts))
    const until = Date.parse(String(e.until))
    if (Number.isNaN(ts) || Number.isNaN(until)) continue
    const key = cooldownKey(harness, model, scope)
    const prev = latest.get(key)
    if (!prev || ts > prev.ts) {
      latest.set(key, { ts, until, outcome: String(e.outcome ?? ''), scope, source: String(e.source ?? '') })
    }
  }
  const cleared = (key: string, hitTs: number): boolean => {
    const slash = key.indexOf('/')
    const harness = key.slice(0, slash)
    const rest = key.slice(slash + 1)
    if (rest === '*') return (okHarness.get(harness) ?? -Infinity) > hitTs
    return (okModel.get(key) ?? -Infinity) > hitTs
  }
  const cooldowns = new Map<string, Cooldown>()
  const halfOpen = new Map<string, { until: number; outcome: string; source: string }>()
  for (const [key, v] of latest) {
    if (cleared(key, v.ts)) continue
    if (v.until > now) {
      cooldowns.set(key, { until: v.until, outcome: v.outcome, scope: v.scope, source: v.source })
    } else {
      halfOpen.set(key, { until: v.until, outcome: v.outcome, source: v.source })
    }
  }
  return { now, cooldowns, halfOpen }
}

export function coolingOf(state: State, row: { harness: string; model: string }): Cooldown | undefined {
  const direct = state.cooldowns.get(`${row.harness}/${row.model}`)
  if (direct && direct.until > state.now) return direct
  const acct = state.cooldowns.get(`${row.harness}/*`)
  if (acct && acct.until > state.now) return acct
  return undefined
}

export function isCooling(
  state: State,
  row: { harness: string; model: string }
): { until: number; outcome: string } | undefined {
  const c = coolingOf(state, row)
  return c ? { until: c.until, outcome: c.outcome } : undefined
}

export function halfOpenTrialKey(state: State, row: { harness: string; model: string }): string | undefined {
  if (state.halfOpen.has(`${row.harness}/${row.model}`)) return `${row.harness}/${row.model}`
  if (state.halfOpen.has(`${row.harness}/*`)) return `${row.harness}/*`
  return undefined
}

export function waitTarget(
  state: State,
  rows: { harness: string; model: string }[]
): { harness: string; model: string; until: number } | undefined {
  let best: { harness: string; model: string; until: number } | undefined
  for (const row of rows) {
    const c = coolingOf(state, row)
    if (!c || c.source !== 'stated') continue
    if (!best || c.until < best.until) best = { harness: row.harness, model: row.model, until: c.until }
  }
  return best
}

function trialLockPath(key: string): string {
  return join(runDir(), `trial-${encodeURIComponent(key)}.lock`)
}

function lockAlive(raw: string): boolean {
  try {
    const o = JSON.parse(raw) as { pid?: unknown; startTicks?: unknown }
    const pid = Number(o.pid)
    const ticks = Number(o.startTicks)
    if (!Number.isFinite(pid) || pid <= 0) return false
    if (!Number.isFinite(ticks) || ticks === 0) return false
    return readStartTicks(pid) === ticks
  } catch {
    return false
  }
}

function lockMine(raw: string): boolean {
  try {
    const o = JSON.parse(raw) as { pid?: unknown; startTicks?: unknown }
    return Number(o.pid) === process.pid && Number(o.startTicks) === readStartTicks(process.pid)
  } catch {
    return false
  }
}

/** Exclusive-create the trial lock for a half-open key. True when this run owns the trial. */
export function takeTrial(key: string): boolean {
  const path = trialLockPath(key)
  const mine = JSON.stringify({ pid: process.pid, startTicks: readStartTicks(process.pid) })
  try {
    writeFileSync(path, mine, { flag: 'wx', mode: 0o600 })
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') return false
  }
  let raw = ''
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return false
  }
  if (lockMine(raw)) return true
  if (lockAlive(raw)) return false
  try {
    unlinkSync(path)
  } catch {
    return false
  }
  try {
    writeFileSync(path, mine, { flag: 'wx', mode: 0o600 })
    return true
  } catch {
    return false
  }
}

export function releaseTrial(key: string): void {
  try {
    if (existsSync(trialLockPath(key))) unlinkSync(trialLockPath(key))
  } catch {
    // lock cleanup never breaks a run
  }
}

export function backoffUntil(harness: string, model: string, scope: 'model' | 'account', now: number): number {
  const events = readEvents(now - WINDOW_MS)
  let lastOk = -Infinity
  const hits: number[] = []
  for (const e of events) {
    if (e.harness !== harness) continue
    const ts = Date.parse(String(e.ts))
    if (Number.isNaN(ts) || ts > now) continue
    if (e.event === 'job_end' && e.outcome === 'ok') {
      if (scope === 'account' || e.model === model) {
        if (ts > lastOk) lastOk = ts
      }
      continue
    }
    if (e.event !== 'limit_hit') continue
    if (scope === 'account') {
      if (e.scope !== 'account') continue
    } else if (e.scope === 'account' || e.model !== model) {
      continue
    }
    hits.push(ts)
  }
  hits.sort((a, b) => a - b)
  let k = 0
  let last = -Infinity
  for (const ts of hits) {
    if (ts <= lastOk) continue
    if (ts - last >= 60_000) {
      k += 1
      last = ts
    }
  }
  return now + Math.min(4 * 3600 * 1000, 15 * 60 * 1000 * 2 ** k)
}
