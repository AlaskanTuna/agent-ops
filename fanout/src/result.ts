export interface ChainResult {
  code: number
  block: string
}

export interface Hop {
  fromHarness: string
  fromModel: string
  outcome: string
  resetsHHMM?: string
  toHarness: string
  toModel: string
}

export function formatLocalHM(ms: number): string {
  const tz = process.env.TZ || 'UTC'
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(
    new Date(ms)
  )
}

export interface Retry {
  harness: string
  model: string
  outcome: string
}

export interface PreFallback {
  expected: string
  reason: string
  toHarness: string
  toModel: string
}

export function renderBlock(o: {
  job: string
  harness: string
  model: string
  outcome: string
  attempt: number
  worktree?: string
  patch?: string
  fallbacks?: Hop[]
  retries?: Retry[]
  preFallback?: PreFallback
  notes?: string[]
  denials?: number
  failed?: string
}): ChainResult {
  const lines = [`FANOUT job=${o.job} harness=${o.harness} model=${o.model} outcome=${o.outcome} attempt=${o.attempt}`]
  if (o.preFallback) {
    lines.push(
      `FALLBACK ${o.preFallback.expected} not started (${o.preFallback.reason}) -> ${o.preFallback.toHarness}/${o.preFallback.toModel}. Tell the user, then run: fanout ack ${o.job}`
    )
  }
  for (const h of o.fallbacks ?? []) {
    const resets = h.resetsHHMM ? ` (resets ${h.resetsHHMM})` : ''
    lines.push(
      `FALLBACK ${h.fromHarness}/${h.fromModel} ${h.outcome}${resets} -> ${h.toHarness}/${h.toModel}. Tell the user, then run: fanout ack ${o.job}`
    )
  }
  for (const r of o.retries ?? []) {
    lines.push(`RETRY ${r.harness}/${r.model} ${r.outcome}; retried once on the same model`)
  }
  for (const n of o.notes ?? []) lines.push(n)
  if (o.denials !== undefined) lines.push(`DENIALS=${o.denials}`)
  if (o.worktree) lines.push(`WORKTREE=${o.worktree}`)
  if (o.patch) lines.push(`PATCH=${o.patch}`)
  if (o.failed) lines.push(o.failed)
  const block = lines.join('\n')
  return { code: o.outcome === 'ok' ? 0 : 1, block }
}
