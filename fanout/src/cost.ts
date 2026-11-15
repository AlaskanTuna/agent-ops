import { type CatalogRow, kindInfo } from './catalog'

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

export function formatUsd(n: number): string {
  if (n >= 0.01) return `$${n.toFixed(2)}`
  return `$${n.toFixed(4)}`
}
