import { estimate } from './cost'
import { billingRank, type Candidate } from './pick'

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
  return ka < kb ? -1 : ka > kb ? 1 : 0
}
