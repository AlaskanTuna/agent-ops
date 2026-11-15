import { readEvents } from './events'
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
  for (const e of events) {
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
  const cooldowns = new Map<string, Cooldown>()
  for (const [key, v] of latest) {
    if (v.until > now) cooldowns.set(key, { until: v.until, outcome: v.outcome, scope: v.scope, source: v.source })
  }
  return { now, cooldowns }
}

export function isCooling(
  state: State,
  row: { harness: string; model: string }
): { until: number; outcome: string } | undefined {
  const direct = state.cooldowns.get(`${row.harness}/${row.model}`)
  if (direct && direct.until > state.now) return { until: direct.until, outcome: direct.outcome }
  const acct = state.cooldowns.get(`${row.harness}/*`)
  if (acct && acct.until > state.now) return { until: acct.until, outcome: acct.outcome }
  return undefined
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
