import { type Billing, type CatalogRow, kindInfo } from './catalog'
import { upstreamClass } from './dataclass'
import { compareRows } from './rank'

export interface PickInput {
  kind: string
  startTier?: number
  harness?: string
  briefBytes: number
  dataClass: 'public' | 'private'
  noPaid?: boolean
  upstreamOf?: (row: CatalogRow) => string | undefined
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
  const eligible = rows.filter((row) => {
    if (row.status !== 'active') return false
    if (row.tier < startTier) return false
    if (input.briefBytes < row.minBriefBytes) return false
    if (input.dataClass === 'private' && row.dataClass === 'public-only') return false
    if (input.dataClass === 'private' && upstreamClass(input.upstreamOf?.(row)) === 'public-only') {
      return false
    }
    if (input.noPaid && (row.billing === 'paid' || row.billing === 'per_call')) return false
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
