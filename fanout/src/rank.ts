import { estimate } from './cost'
import { billingRank, type Candidate } from './pick'
import { readBenchmarks, type BenchmarkMap } from './benchmarks'
import { loadCatalog } from './catalog'
import { userBand } from './state'

interface TierBench {
  /** Metrics present on every scored row of the tier. */
  shared: Set<string>
  /** Max value per shared metric over the tier's rows. */
  max: Map<string, number>
  /** Row keys with any benchmark data. */
  scored: Set<string>
  bench: BenchmarkMap
}

const tierCache = new Map<number, TierBench>()

function tierBench(tier: number): TierBench {
  const hit = tierCache.get(tier)
  if (hit) return hit
  const built: TierBench = { shared: new Set(), max: new Map(), scored: new Set(), bench: {} }
  try {
    built.bench = readBenchmarks()
  } catch {
    built.bench = {}
  }
  let keys: string[] = []
  try {
    keys = loadCatalog()
      .rows.filter((r) => r.tier === tier)
      .map((r) => `${r.harness}/${r.model}`)
  } catch {
    keys = []
  }
  const perRow = new Map<string, Record<string, number>>()
  for (const key of keys) {
    const b = built.bench[key]
    if (!b || Object.keys(b).length === 0) continue
    perRow.set(key, b)
    built.scored.add(key)
  }
  let shared: Set<string> | undefined
  for (const b of perRow.values()) {
    const metrics = new Set(Object.keys(b))
    shared = shared === undefined ? metrics : new Set([...shared].filter((m) => metrics.has(m)))
  }
  built.shared = shared ?? new Set()
  for (const m of built.shared) {
    let mx = 0
    for (const b of perRow.values()) {
      if (typeof b[m] === 'number' && b[m] > mx) mx = b[m]
    }
    built.max.set(m, mx)
  }
  tierCache.set(tier, built)
  return built
}

/** Mean over the shared metrics of value / max. Rows with no data score undefined. */
function benchmarkScore(key: string, tb: TierBench): number | undefined {
  if (!tb.scored.has(key) || tb.shared.size === 0) return undefined
  const b = tb.bench[key] ?? {}
  let sum = 0
  for (const m of tb.shared) {
    const v = b[m]
    const mx = tb.max.get(m) ?? 0
    if (typeof v !== 'number') return undefined
    sum += mx <= 0 ? 1 : v / mx
  }
  return sum / tb.shared.size
}

export function compareRows(a: Candidate, b: Candidate, kind: string): number {
  if (a.row.tier !== b.row.tier) return a.row.tier - b.row.tier
  const br = billingRank(a.row.billing) - billingRank(b.row.billing)
  if (br !== 0) return br
  if (a.row.billing === 'paid' && b.row.billing === 'paid') {
    const ea = estimate(a.row, kind)?.usd
    const eb = estimate(b.row, kind)?.usd
    if (ea !== undefined && eb !== undefined && ea !== eb) return ea - eb
    if (ea === undefined && eb !== undefined) return 1
    if (ea !== undefined && eb === undefined) return -1
  }
  const ka = `${a.row.harness}/${a.row.model}`
  const kb = `${b.row.harness}/${b.row.model}`
  const band = userBand(ka, kb, kind)
  if (band !== 0) return band
  const tb = tierBench(a.row.tier)
  const sa = benchmarkScore(ka, tb)
  const sb = benchmarkScore(kb, tb)
  if (sa !== undefined && sb !== undefined && sa !== sb) return sb - sa
  if (sa !== undefined && sb === undefined) return -1
  if (sa === undefined && sb !== undefined) return 1
  return ka < kb ? -1 : ka > kb ? 1 : 0
}
