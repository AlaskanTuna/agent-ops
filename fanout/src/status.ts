import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatUsd } from './cost'
import { loadCatalog } from './catalog'
import { nowMs } from './clock'
import { runDir } from './paths'
import { chains, readState, type Chain } from './state'

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
  if (lines.length === 0) return ['fanout: ok']
  return lines
}

export function fullLines(now: number): string[] {
  const lines = briefLines(now)
  const { rows } = loadCatalog()
  for (const row of rows) {
    lines.push(`${row.harness}/${row.model} tier=${row.tier} ${row.status} ${row.billing} ${row.dataClass}`)
  }
  return lines
}

export function statusNow(): number {
  return nowMs()
}
