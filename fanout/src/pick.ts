import { type Billing, type CatalogRow, kindInfo } from './catalog'
import { upstreamClass } from './dataclass'
import { compareRows } from './rank'
import { nowMs } from './clock'
import { coolingOf, isCooling, readState } from './state'

export interface PickInput {
  kind: string
  startTier?: number
  harness?: string
  briefBytes: number
  dataClass: 'public' | 'private'
  noPaid?: boolean
  upstreamOf?: (row: CatalogRow) => string | undefined
  includeCooling?: boolean
}

export interface Candidate {
  row: CatalogRow
  effort: string
}

export function billingRank(b: Billing): number {
  if (b === 'free' || b === 'subscription') return 0
  if (b === 'paid') return 1
  return 2
}

export function candidates(rows: CatalogRow[], input: PickInput): Candidate[] {
  const startTier = input.startTier ?? kindInfo(input.kind).tier
  const state = readState(nowMs())
  const eligible = rows.filter((row) => {
    if (row.status !== 'active') return false
    if (row.tier < startTier) return false
    if (input.briefBytes < row.minBriefBytes) return false
    if (input.dataClass === 'private' && row.dataClass === 'public-only') return false
    if (input.dataClass === 'private' && upstreamClass(input.upstreamOf?.(row)) === 'public-only') {
      return false
    }
    if (input.noPaid && (row.billing === 'paid' || row.billing === 'per_call')) return false
    if (!input.includeCooling && isCooling(state, row)) return false
    return true
  })
  const pref = input.harness
  const withEffort: Candidate[] = eligible.map((row) => ({ row, effort: row.efforts[0] ?? '' }))
  withEffort.sort((a, b) => compareRows(a, b, input.kind))
  if (pref && withEffort.length > 0) {
    const firstTier = withEffort[0].row.tier
    const idx = withEffort.findIndex((c) => c.row.harness === pref && c.row.tier === firstTier)
    if (idx > 0) {
      const [moved] = withEffort.splice(idx, 1)
      withEffort.unshift(moved)
    }
  }
  return withEffort
}

export function nextCandidate(
  ordered: Candidate[],
  tried: Set<string>,
  skippedHarness: Set<string>,
  extra?: Set<string>
): Candidate | undefined {
  return ordered.find(
    (c) =>
      !tried.has(`${c.row.harness}/${c.row.model}`) &&
      !skippedHarness.has(c.row.harness) &&
      !extra?.has(`${c.row.harness}/${c.row.model}`)
  )
}

/** Ordered climb rungs for a row: the row's own default first, then its climb list. */
export function climbSteps(row: CatalogRow): { model: string; effort: string }[] {
  const steps = [{ model: row.model, effort: row.efforts[0] ?? '' }]
  for (const entry of row.climb) {
    const at = entry.indexOf('@')
    if (at >= 0) steps.push({ model: entry.slice(0, at), effort: entry.slice(at + 1) })
    else steps.push({ model: entry, effort: '' })
  }
  return steps
}

export interface Rung {
  row: CatalogRow
  effort: string
}

/** Next rung after a finished job: the following climb step, else the best row one tier above. */
export function nextRung(
  job: { harness: string; model: string; effort?: string; tier: number },
  rows: CatalogRow[],
  o: {
    kind: string
    briefBytes: number
    dataClass: 'public' | 'private'
    noPaid?: boolean
    upstreamOf?: (row: CatalogRow) => string | undefined
  }
): Rung | 'top' | undefined {
  const state = readState(nowMs())
  const jobRow = rows.find((r) => r.harness === job.harness && r.model === job.model)
  const eligible = (row: CatalogRow): boolean => {
    if (row.status !== 'active') return false
    if (o.briefBytes < row.minBriefBytes) return false
    if (o.dataClass === 'private' && row.dataClass === 'public-only') return false
    if (o.dataClass === 'private' && upstreamClass(o.upstreamOf?.(row)) === 'public-only') return false
    if (o.noPaid && (row.billing === 'paid' || row.billing === 'per_call')) return false
    if (coolingOf(state, row)) return false
    return true
  }
  if (jobRow) {
    const steps = climbSteps(jobRow)
    const jobEffort = job.effort ?? ''
    let idx = steps.findIndex((s) => s.model === job.model && (s.effort === '' || s.effort === jobEffort))
    if (idx < 0) idx = steps.findIndex((s) => s.model === job.model)
    for (const step of steps.slice(idx + 1)) {
      const target = rows.find((r) => r.harness === job.harness && r.model === step.model)
      if (!target || !eligible(target)) continue
      return { row: target, effort: step.effort || target.efforts[0] || '' }
    }
  }
  const jobTier = jobRow ? jobRow.tier : job.tier
  if (jobTier >= 3) return 'top'
  const above = candidates(rows, {
    kind: o.kind,
    startTier: jobTier + 1,
    briefBytes: o.briefBytes,
    dataClass: o.dataClass,
    noPaid: o.noPaid,
    upstreamOf: o.upstreamOf
  })
  const first = above[0]
  return first ? { row: first.row, effort: first.effort } : undefined
}

/** Resolve `<harness>/<model>` or a bare model id to a catalog row. Ambiguity resolves to the top-ranked row. */
export function resolveModel(rows: CatalogRow[], spec: string, harness?: string): CatalogRow | undefined {
  const slash = spec.indexOf('/')
  if (slash >= 0) {
    const h = spec.slice(0, slash)
    const m = spec.slice(slash + 1)
    if (harness && h !== harness) return undefined
    return rows.find((r) => r.harness === h && r.model === m)
  }
  const matches = rows.filter((r) => r.model === spec && (!harness || r.harness === harness))
  if (matches.length === 0) return undefined
  matches.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier
    const br = billingRank(a.billing) - billingRank(b.billing)
    if (br !== 0) return br
    const ka = `${a.harness}/${a.model}`
    const kb = `${b.harness}/${b.model}`
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
  return matches[0]
}
