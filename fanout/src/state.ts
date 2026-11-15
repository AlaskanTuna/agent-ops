import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readStartTicks } from './exec'
import { readEvents, type FanoutEvent } from './events'
import { leasePath } from './lease'
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

export interface ChainHop {
  fromHarness: string
  fromModel: string
  outcome: string
  resetsHHMM?: string
  toHarness: string
  toModel: string
}

export interface ChainPaid {
  harness: string
  model: string
  billing: 'paid' | 'per_call'
  estUsd?: number
  estMc?: number
  estCalls?: number
  actualUsd?: number
  actualMc?: number
  actualCalls?: number
  measured: boolean
}

export interface Chain {
  root: string
  finalJob: string
  firstTs: string
  finished: boolean
  running: boolean
  hops: ChainHop[]
  paidJobs: ChainPaid[]
  rerouted?: { expected: string; harness: string; model: string }
  reported: boolean
  caller: string
  session?: string
}

function localHM(ms: number): string {
  const tz = process.env.TZ || 'UTC'
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(
    new Date(ms)
  )
}

function leaseRoots(): Set<string> {
  const out = new Set<string>()
  try {
    for (const f of readdirSync(runDir())) {
      if (f.endsWith('.lease')) out.add(f.slice(0, -'.lease'.length))
    }
  } catch {
    // missing run dir means nothing is running
  }
  return out
}

/** Group the last 30 days of events into chains keyed by root. */
export function chains(now: number): Chain[] {
  const events = readEvents(now - LEDGER_WINDOW_MS)
  const live = leaseRoots()
  const starts = new Map<string, FanoutEvent[]>()
  const ends = new Map<string, FanoutEvent>()
  const hits = new Map<string, FanoutEvent[]>()
  const reportedRoots = new Set<string>()
  for (const e of events) {
    if (e.event === 'job_start') {
      const root = String(e.root ?? e.job)
      const list = starts.get(root) ?? []
      list.push(e)
      starts.set(root, list)
    } else if (e.event === 'job_end') {
      ends.set(String(e.job), e)
    } else if (e.event === 'limit_hit') {
      const key = String(e.job)
      const list = hits.get(key) ?? []
      list.push(e)
      hits.set(key, list)
    } else if (e.event === 'reported' && e.root !== undefined) {
      reportedRoots.add(String(e.root))
    }
  }
  const out: Chain[] = []
  for (const [root, list] of starts) {
    list.sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || String(a.id).localeCompare(String(b.id)))
    const running = live.has(root) || existsSync(leasePath(root))
    const last = list[list.length - 1]
    const finished = !running && ends.has(String(last.job))
    const hops: ChainHop[] = []
    for (let i = 0; i + 1 < list.length; i++) {
      const from = list[i]
      const to = list[i + 1]
      const fh = String(from.harness)
      const fm = String(from.model)
      if (fh === String(to.harness) && fm === String(to.model)) continue
      const end = ends.get(String(from.job))
      const hop: ChainHop = {
        fromHarness: fh,
        fromModel: fm,
        outcome: String(end?.outcome ?? 'unknown'),
        toHarness: String(to.harness),
        toModel: String(to.model)
      }
      const hit = (hits.get(String(from.job)) ?? []).find((h) => h.source === 'stated' && h.until !== undefined)
      if (hit) {
        const ms = Date.parse(String(hit.until))
        if (!Number.isNaN(ms)) hop.resetsHHMM = localHM(ms)
      }
      hops.push(hop)
    }
    const paidJobs: ChainPaid[] = []
    for (const s of list) {
      if (s.billing !== 'paid' && s.billing !== 'per_call') continue
      const end = ends.get(String(s.job))
      const paid: ChainPaid = {
        harness: String(s.harness),
        model: String(s.model),
        billing: s.billing,
        measured: end?.cost_source === 'computed'
      }
      if (typeof s.cost_est_usd === 'number') paid.estUsd = s.cost_est_usd
      if (typeof s.cost_est_mc === 'number') paid.estMc = s.cost_est_mc
      if (typeof s.calls_est === 'number') paid.estCalls = s.calls_est
      if (typeof end?.cost_usd === 'number') paid.actualUsd = end.cost_usd as number
      if (typeof end?.cost_mc === 'number') paid.actualMc = end.cost_mc as number
      if (typeof end?.calls === 'number') paid.actualCalls = end.calls as number
      paidJobs.push(paid)
    }
    const first = list[0]
    const expected = typeof first.expected === 'string' ? first.expected : undefined
    const firstKey = `${String(first.harness)}/${String(first.model)}`
    out.push({
      root,
      finalJob: String(last.job),
      firstTs: String(first.ts),
      finished,
      running,
      hops,
      paidJobs,
      ...(expected && expected !== firstKey
        ? { rerouted: { expected, harness: String(first.harness), model: String(first.model) } }
        : {}),
      reported: reportedRoots.has(root),
      caller: typeof first.caller === 'string' ? first.caller : 'unknown',
      ...(typeof first.session === 'string' ? { session: first.session } : {})
    })
  }
  out.sort((a, b) => a.firstTs.localeCompare(b.firstTs) || a.root.localeCompare(b.root))
  return out
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
