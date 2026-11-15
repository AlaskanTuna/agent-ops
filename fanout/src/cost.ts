import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Adapter, type Usage } from './adapters/types'
import { type CatalogRow, kindInfo, loadCatalog } from './catalog'
import { LEDGER_WINDOW_MS, nowMs } from './clock'
import { readEvents } from './events'
import { runDir } from './paths'

export type EstimateBasis = 'prior' | 'history' | 'per_call'

export interface Estimate {
  usd?: number
  mc?: number
  calls?: number
  basis: EstimateBasis
  samples: number
}

export function estimate(row: CatalogRow, kind: string, o?: { maxTurns?: number }): Estimate | undefined {
  if (row.billing === 'paid') {
    const history = historyTokens(row, kind)
    if (history && history.samples >= 5) {
      const usd =
        (history.tokensIn * (row.priceIn ?? 0) +
          history.tokensCached * (row.priceCached ?? 0) +
          history.tokensOut * (row.priceOut ?? 0)) /
        1e6
      return { usd, basis: 'history', samples: history.samples }
    }
    const prior = kindInfo(kind).prior ?? [300000, 600000, 30000]
    const [tin, tcached, tout] = prior
    const usd = (tin * (row.priceIn ?? 0) + tcached * (row.priceCached ?? 0) + tout * (row.priceOut ?? 0)) / 1e6
    return { usd, basis: 'prior', samples: 0 }
  }
  if (row.billing === 'per_call') {
    const calls = o?.maxTurns ?? 8
    return { mc: calls * (row.priceCall ?? 0), calls, basis: 'per_call', samples: 0 }
  }
  return undefined
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Median (in, cached, out) of `ok` job_ends with an accepted verdict for the
 * same kind and model family. The last verdict per job counts.
 */
function historyTokens(
  row: CatalogRow,
  kind: string
): { tokensIn: number; tokensCached: number; tokensOut: number; samples: number } | undefined {
  let families: Map<string, string>
  try {
    families = new Map(loadCatalog().rows.map((r) => [`${r.harness}/${r.model}`, r.family]))
  } catch {
    return undefined
  }
  if (families.get(`${row.harness}/${row.model}`) !== row.family) return undefined
  const events = readEvents(nowMs() - LEDGER_WINDOW_MS)
  const kinds = new Map<string, string>()
  for (const e of events) {
    if (e.event === 'job_start' && typeof e.job === 'string' && typeof e.kind === 'string') {
      kinds.set(e.job, e.kind)
    }
  }
  const verdicts = new Map<string, boolean>()
  for (const e of events) {
    if (e.event === 'verdict' && typeof e.job === 'string' && typeof e.accepted === 'boolean') {
      verdicts.set(e.job, e.accepted)
    }
  }
  const collect = { in: [] as number[], cached: [] as number[], out: [] as number[] }
  for (const e of events) {
    if (e.event !== 'job_end' || e.outcome !== 'ok') continue
    if (typeof e.job !== 'string' || verdicts.get(e.job) !== true) continue
    if (kinds.get(e.job) !== kind) continue
    const key = `${String(e.harness)}/${String(e.model)}`
    if (families.get(key) !== row.family) continue
    if (typeof e.tokens_in !== 'number' || typeof e.tokens_out !== 'number') continue
    collect.in.push(e.tokens_in)
    collect.cached.push(typeof e.tokens_cached === 'number' ? e.tokens_cached : 0)
    collect.out.push(e.tokens_out)
  }
  if (collect.in.length < 5) return undefined
  return {
    tokensIn: median(collect.in),
    tokensCached: median(collect.cached),
    tokensOut: median(collect.out),
    samples: collect.in.length
  }
}

export function paidCostUsd(usage: Usage, row: CatalogRow): number {
  return (
    (usage.tokensIn * (row.priceIn ?? 0) +
      usage.tokensCached * (row.priceCached ?? 0) +
      usage.tokensOut * (row.priceOut ?? 0)) /
    1e6
  )
}

export function formatUsd(n: number): string {
  if (n >= 0.01) return `$${n.toFixed(2)}`
  return `$${n.toFixed(4)}`
}

export interface CostLine {
  harness: string
  model: string
  billing: 'paid' | 'per_call'
  estUsd?: number
  estMc?: number
  estCalls?: number
  rate?: number
  actualUsd?: number
  actualMc?: number
  actualCalls?: number
  measured: boolean
  basis: string
}

export interface AttemptCost {
  fields: Record<string, unknown>
  line: CostLine | undefined
}

function paidLine(row: CatalogRow, est: Estimate | undefined, usage: Usage | undefined, basis: string): AttemptCost {
  const base: CostLine = {
    harness: row.harness,
    model: row.model,
    billing: 'paid',
    ...(est?.usd !== undefined ? { estUsd: est.usd } : {}),
    measured: false,
    basis
  }
  if (!usage) return { fields: { cost_source: 'unknown' }, line: { ...base } }
  const usd = paidCostUsd(usage, row)
  return { fields: { cost_usd: usd, cost_source: 'computed' }, line: { ...base, actualUsd: usd, measured: true } }
}

export function billableCost(
  row: CatalogRow,
  est: Estimate | undefined,
  usage: Usage | undefined,
  basis: string
): AttemptCost {
  if (row.billing === 'per_call') {
    const base: CostLine = {
      harness: row.harness,
      model: row.model,
      billing: 'per_call',
      ...(est?.mc !== undefined ? { estMc: est.mc, estCalls: est.calls, rate: row.priceCall } : {}),
      measured: false,
      basis: 'counted from proxy log'
    }
    return { fields: { cost_source: 'unknown' }, line: { ...base } }
  }
  return paidLine(row, est, usage, basis)
}

export async function billableCostAsync(
  row: CatalogRow,
  est: Estimate | undefined,
  usage: Usage | undefined,
  startMs: number,
  endMs: number,
  root: string,
  adapter: Adapter,
  isProxyBacked: (harness: string) => boolean
): Promise<AttemptCost> {
  if (row.billing !== 'per_call') return paidLine(row, est, usage, 'computed from tokens')
  const base: CostLine = {
    harness: row.harness,
    model: row.model,
    billing: 'per_call',
    ...(est?.mc !== undefined ? { estMc: est.mc, estCalls: est.calls, rate: row.priceCall } : {}),
    measured: false,
    basis: 'counted from proxy log'
  }
  try {
    const overlapped = isOverlapped(startMs, endMs, root, isProxyBacked)
    const measured = overlapped
      ? ('unmeasured' as const)
      : await adapter.measure?.({ startMs, endMs, route: `${row.harness}/${row.model}`, overlapped })
    if (typeof measured === 'object' && measured !== null) {
      const mc = measured.calls * (row.priceCall ?? 0)
      return {
        fields: { cost_mc: mc, calls: measured.calls, cost_source: 'computed' },
        line: { ...base, actualMc: mc, actualCalls: measured.calls, measured: true }
      }
    }
  } catch {
    // measurement failures leave the actual unmeasured
  }
  return { fields: { cost_source: 'unknown' }, line: { ...base } }
}

export function estimateLine(row: CatalogRow, est: Estimate): string {
  const key = `${row.harness}/${row.model}`
  if (est.usd !== undefined) return `ESTIMATE paid API (${key}): ${formatUsd(est.usd)}`
  return `ESTIMATE per-call (${key}): ${est.mc} MC (${est.calls} turns x ${row.priceCall} MC, upper-bound guess)`
}

/**
 * A per-call attempt counts as overlapped when another job on a proxy-backed
 * harness had a lease or a job window that intersects it. Attribution from a
 * shared proxy log is not possible then, so the actual stays unmeasured.
 */
export function isOverlapped(
  startMs: number,
  endMs: number,
  root: string,
  isProxyBacked: (harness: string) => boolean
): boolean {
  try {
    for (const f of readdirSync(runDir())) {
      if (!f.endsWith('.lease') || f.slice(0, -'.lease'.length) === root) continue
      try {
        const data = JSON.parse(readFileSync(join(runDir(), f), 'utf8')) as {
          harness?: unknown
          started?: unknown
        }
        if (typeof data.harness !== 'string' || !isProxyBacked(data.harness)) continue
        const started = Date.parse(String(data.started))
        if (Number.isNaN(started) || started <= endMs) return true
      } catch {
        // unreadable leases never block a run
      }
    }
  } catch {
    // missing run dir means no overlap
  }
  const windows = new Map<string, { harness: string; start: number; end: number }>()
  for (const e of readEvents(startMs - LEDGER_WINDOW_MS)) {
    if (e.root !== undefined && e.root !== root) {
      const key = String(e.root)
      const ts = Date.parse(String(e.ts))
      if (Number.isNaN(ts)) continue
      if (e.event === 'job_start' && typeof e.harness === 'string') {
        const w = windows.get(key)
        if (!w || ts < w.start) windows.set(key, { harness: e.harness, start: ts, end: w?.end ?? NaN })
      } else if (e.event === 'job_end') {
        const w = windows.get(key)
        if (w && (Number.isNaN(w.end) || ts > w.end)) w.end = ts
      }
    }
  }
  for (const w of windows.values()) {
    if (!isProxyBacked(w.harness)) continue
    const end = Number.isNaN(w.end) ? Date.now() : w.end
    if (w.start <= endMs && end >= startMs) return true
  }
  return false
}
