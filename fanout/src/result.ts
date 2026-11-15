export interface ChainResult {
  code: number
  block: string
}

export function renderBlock(o: {
  job: string
  harness: string
  model: string
  outcome: string
  attempt: number
}): ChainResult {
  const line = `FANOUT job=${o.job} harness=${o.harness} model=${o.model} outcome=${o.outcome} attempt=${o.attempt}`
  return { code: o.outcome === 'ok' ? 0 : 1, block: line }
}
