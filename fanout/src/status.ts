import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatUsd } from './cost'
import { loadCatalog } from './catalog'
import { readBenchmarksDoc } from './benchmarks'
import { DAY_MS, LEDGER_WINDOW_MS, nowMs } from './clock'
import { readEvents } from './events'
import { runDir } from './paths'
import { chains, paidTrialKeys, readLearned, readState, smokeSummary, type Chain } from './state'
import { readStatusJson } from './upkeep/index'

function localHM(ms: number): string {
  const tz = process.env.TZ || 'UTC'
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(
    new Date(ms)
  )
}

function runningLines(): string[] {
  const lines: string[] = []
  let files: string[] = []
  try {
    files = readdirSync(runDir())
  } catch {
    return lines
  }
  for (const f of files.sort()) {
    if (!f.endsWith('.lease')) continue
    const root = f.slice(0, -'.lease'.length)
    try {
      const data = JSON.parse(readFileSync(join(runDir(), f), 'utf8')) as {
        harness?: unknown
        model?: unknown
        started?: unknown
      }
      if (typeof data.harness !== 'string' || typeof data.model !== 'string') continue
      const since = Date.parse(String(data.started))
      lines.push(
        `RUNNING ${root} ${data.harness}/${data.model} since ${Number.isNaN(since) ? '??:??' : localHM(since)}`
      )
    } catch {
      // unreadable leases are skipped
    }
  }
  return lines
}

function paidSummary(p: Chain['paidJobs'][number]): string {
  const key = `${p.harness}/${p.model}`
  if (p.billing === 'per_call') {
    const est = `estimated ${p.estMc} MC`
    const actual = p.measured ? `actual ${p.actualCalls} calls = ${p.actualMc} MC` : 'actual unmeasured'
    return `per-call ${key}: ${est}, ${actual}`
  }
  const est = `estimated ${formatUsd(p.estUsd ?? 0)}`
  const actual = p.measured ? `actual ${formatUsd(p.actualUsd ?? 0)}` : 'actual unknown'
  return `paid ${key}: ${est}, ${actual}`
}

export function unreportedSummary(chain: Chain): string {
  const parts: string[] = []
  for (const h of chain.hops) {
    parts.push(`fallback ${h.fromHarness}/${h.fromModel} -> ${h.toHarness}/${h.toModel}`)
  }
  if (chain.rerouted) {
    parts.push(`reroute ${chain.rerouted.expected} -> ${chain.rerouted.harness}/${chain.rerouted.model}`)
  }
  for (const p of chain.paidJobs) parts.push(paidSummary(p))
  return parts.join('; ')
}

export function briefLines(now: number): string[] {
  const lines: string[] = []
  const state = readState(now)
  for (const key of [...state.cooldowns.keys()].sort()) {
    const c = state.cooldowns.get(key)
    if (!c) continue
    lines.push(`COOLDOWN ${key} until ${localHM(c.until)} (${c.outcome})`)
  }
  lines.push(...runningLines())
  for (const chain of chains(now)) {
    if (!chain.finished || chain.reported || chain.caller === 'upkeep') continue
    if (chain.hops.length === 0 && !chain.rerouted && chain.paidJobs.length === 0) continue
    lines.push(`UNREPORTED ${chain.finalJob} ${unreportedSummary(chain)} (run: fanout ack ${chain.finalJob})`)
  }
  lines.push(...upkeepLines(now))
  lines.push(...benchLines(now))
  lines.push(...discoveryLines())
  lines.push(...smokeStatusLines(now))
  if (lines.length === 0) return ['fanout: ok']
  return lines
}

/** Stateless UPKEEP line from the last 24 hours of upkeep events, in time order. */
export function upkeepLines(now: number): string[] {
  const events = readEvents(now - DAY_MS)
  const steps = events
    .filter((e) => e.event === 'upkeep')
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || String(a.id).localeCompare(String(b.id)))
  if (steps.length === 0) return []
  const starts = events.filter((e) => e.event === 'job_start' && e.caller === 'upkeep')
  const parts = steps.map((u, i) => {
    const from = Date.parse(String(u.ts))
    const next = i + 1 < steps.length ? Date.parse(String(steps[i + 1].ts)) : from + 10 * 60 * 1000
    const during = starts.find((s) => {
      const ts = Date.parse(String(s.ts))
      return Number.isFinite(ts) && Number.isFinite(from) && ts >= from && ts < next
    })
    const via =
      during !== undefined && typeof during.harness === 'string' && typeof during.model === 'string'
        ? ` via ${String(during.harness)}/${String(during.model)}`
        : ''
    return `${String(u.step)} ${String(u.status)}${via}`
  })
  return [`UPKEEP (24h): ${parts.join(', ')}`]
}

export function fullLines(now: number): string[] {
  const lines = briefLines(now)
  const { rows } = loadCatalog()
  const gone = readLearned().gone
  for (const row of rows) {
    const key = `${row.harness}/${row.model}`
    lines.push(`${key} tier=${row.tier} ${row.status} ${row.billing} ${row.dataClass}${gone.has(key) ? ' gone' : ''}`)
  }
  return lines
}

function joinedLine(label: string, keys: string[]): string | undefined {
  if (keys.length === 0) return undefined
  const shown = keys.slice(0, 5)
  const more = keys.length > 5 ? ` (+${keys.length - 5} more)` : ''
  return `${label} ${shown.join(', ')}${more}`
}

/** SMOKE counts and paid trials awaiting first use. Shown once upkeep has smoked. */
export function smokeStatusLines(now: number): string[] {
  const { rows } = loadCatalog()
  const learned = readLearned()
  const summary = smokeSummary(rows, learned, now)
  const lines: string[] = []
  if (summary.pass > 0 || summary.fail > 0) {
    lines.push(`SMOKE pass=${summary.pass} fail=${summary.fail} pending=${summary.pending}`)
  }
  const paid = paidTrialKeys(rows, learned)
  if (paid.length > 0) lines.push(`NEW (paid, promoted on first use): ${paid.join(', ')}`)
  return lines
}
/** NEW and GONE lines from the last upkeep's status.json. */
export function discoveryLines(): string[] {
  let doc: Record<string, unknown> | undefined
  try {
    doc = readStatusJson()
  } catch {
    return []
  }
  if (!doc) return []
  const lines: string[] = []
  const fresh = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const added = joinedLine('NEW', fresh(doc.new_models))
  if (added) lines.push(added)
  const gone = joinedLine('GONE', fresh(doc.gone_models))
  if (gone) lines.push(gone)
  return lines
}

export function statusNow(): number {
  return nowMs()
}

/** BENCH lines for the Artificial Analysis refresh: a missed key, a failed attempt, or a stale snapshot. */
export function benchLines(now: number): string[] {
  const attempts = readEvents(now - LEDGER_WINDOW_MS)
    .filter((e) => e.event === 'upkeep' && e.step === 'benchmarks')
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || String(a.id).localeCompare(String(b.id)))
  const last = attempts[attempts.length - 1]
  const doc = readBenchmarksDoc()
  const stamp = typeof doc?.refreshed_at === 'string' ? doc.refreshed_at : undefined
  const from = stamp && /^\d{4}-\d{2}-\d{2}/.test(stamp) ? stamp.slice(0, 10) : 'the bundled seed'
  const lines: string[] = []
  if (last && last.status !== 'ok') {
    const detail = String(last.detail ?? '')
    if (last.status === 'skipped' && detail === 'no AA_API_KEY') {
      lines.push(`BENCH aa skipped: AA_API_KEY missing (values from ${from})`)
    } else if (last.status === 'failed') {
      lines.push(`BENCH aa failed: ${detail} (values from ${from})`)
    }
  }
  const ms = stamp ? Date.parse(stamp) : NaN
  if (Number.isFinite(ms) && now - ms > 3 * DAY_MS) {
    lines.push(`BENCH aa stale: last refresh ${Math.floor((now - ms) / DAY_MS)} days ago`)
  }
  return lines
}
