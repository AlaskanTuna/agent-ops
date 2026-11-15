import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatUsd, type CostLine } from './cost'
import { loadCatalog } from './catalog'
import { LEDGER_WINDOW_MS, nowMs } from './clock'
import { readEvents, type FanoutEvent } from './events'
import { dataDir } from './paths'

export { type CostLine }

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

export interface ChainResult {
  code: number
  block: string
}

export interface LiveBlockInput {
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
  costs?: CostLine[]
  notes?: string[]
  denials?: number
  failed?: string
}

/** Render a block from explicit in-memory attempt data (used by adapters in tests). */
export function renderLiveBlock(o: LiveBlockInput): ChainResult {
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
  for (const c of o.costs ?? []) lines.push(costLineText(c, o.job))
  for (const n of o.notes ?? []) lines.push(n)
  if (o.denials !== undefined) lines.push(`DENIALS=${o.denials}`)
  if (o.worktree) lines.push(`WORKTREE=${o.worktree}`)
  if (o.patch) lines.push(`PATCH=${o.patch}`)
  if (o.failed) lines.push(o.failed)
  const block = lines.join('\n')
  return { code: o.outcome === 'ok' ? 0 : 1, block }
}

export interface RenderExtra {
  preFallback?: PreFallback
  notes?: string[]
  failedText?: string
  /**
   * In-memory fallback for fail-open mode (unwritable ledger): the ledger
   * carries no events, so FALLBACK and COST lines cannot be rebuilt. The
   * FANOUT line, notes, hand-back paths and failure text still render.
   */
  live?: {
    job: string
    harness: string
    model: string
    outcome: string
    attempt: number
    worktree?: string
    patch?: string
  }
}

function costLineText(c: CostLine, job: string): string {
  const tail = `Tell the user, then run: fanout ack ${job}`
  if (c.billing === 'paid') {
    const est = formatUsd(c.estUsd ?? 0)
    if (c.measured)
      return `COST paid API (${c.harness}/${c.model}): estimated ${est}, actual ${formatUsd(c.actualUsd ?? 0)} (${c.basis}). ${tail}`
    return `COST paid API (${c.harness}/${c.model}): estimated ${est}, actual unknown. ${tail}`
  }
  const rate = c.rate ?? (c.estCalls ? (c.estMc ?? 0) / c.estCalls : 0)
  const est = `estimated ${c.estMc} MC (${c.estCalls} turns x ${rate} MC, upper-bound guess)`
  if (c.measured)
    return `COST per-call (${c.harness}/${c.model}): ${est}, actual ${c.actualCalls} calls = ${c.actualMc} MC (${c.basis}). ${tail}`
  return `COST per-call (${c.harness}/${c.model}): ${est}, actual unmeasured. ${tail}`
}

export function renderBlock(root: string, extra?: RenderExtra): string | undefined
export function renderBlock(o: LiveBlockInput): ChainResult
export function renderBlock(arg: string | LiveBlockInput, extra?: RenderExtra): string | ChainResult | undefined {
  if (typeof arg === 'string') return renderLedgerBlock(arg, extra)
  return renderLiveBlock(arg)
}

/**
 * Rebuild the whole result block for a chain from the ledger (and the worker
 * log paths it names). `run` renders through this too, so the live block and
 * a rebuilt one cannot differ on ledger-derived lines.
 */
function renderLedgerBlock(root: string, extra?: RenderExtra): string | undefined {
  const events = readEvents(nowMs() - LEDGER_WINDOW_MS)
  const starts = events
    .filter((e) => e.event === 'job_start' && String(e.root ?? e.job) === root)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || String(a.id).localeCompare(String(b.id)))
  if (starts.length === 0) {
    const live = extra?.live
    if (!live) return undefined
    const lines = [
      `FANOUT job=${live.job} harness=${live.harness} model=${live.model} outcome=${live.outcome} attempt=${live.attempt}`
    ]
    for (const n of extra?.notes ?? []) lines.push(n)
    if (live.worktree) lines.push(`WORKTREE=${live.worktree}`)
    if (live.patch) lines.push(`PATCH=${live.patch}`)
    if (extra?.failedText) lines.push(extra.failedText)
    return lines.join('\n')
  }
  const ends = new Map<string, FanoutEvent>()
  for (const e of events) {
    if (e.event === 'job_end' && typeof e.job === 'string') ends.set(e.job, e)
  }
  const final = starts[starts.length - 1]
  const finalJob = String(final.job)
  const finalEnd = ends.get(finalJob)
  const outcome = String(finalEnd?.outcome ?? 'unknown')
  const attempt = typeof final.attempt === 'number' ? final.attempt : starts.length
  const lines = [
    `FANOUT job=${finalJob} harness=${String(final.harness)} model=${String(final.model)} outcome=${outcome} attempt=${attempt}`
  ]
  const first = starts[0]
  const expected = typeof first.expected === 'string' ? first.expected : undefined
  const firstKey = `${String(first.harness)}/${String(first.model)}`
  const pre =
    extra?.preFallback ??
    (expected && expected !== firstKey
      ? {
          expected,
          reason: 'not routable',
          toHarness: String(first.harness),
          toModel: String(first.model)
        }
      : undefined)
  if (pre) {
    lines.push(
      `FALLBACK ${pre.expected} not started (${pre.reason}) -> ${pre.toHarness}/${pre.toModel}. Tell the user, then run: fanout ack ${finalJob}`
    )
  }
  const fallbacks: string[] = []
  const retries: string[] = []
  for (let i = 0; i + 1 < starts.length; i++) {
    const from = starts[i]
    const to = starts[i + 1]
    const fh = String(from.harness)
    const fm = String(from.model)
    if (fh === String(to.harness) && fm === String(to.model)) {
      if (String(to.reason) === 'retry') {
        const prevEnd = ends.get(String(from.job))
        retries.push(`RETRY ${fh}/${fm} ${String(prevEnd?.outcome ?? 'unknown')}; retried once on the same model`)
      }
      continue
    }
    const end = ends.get(String(from.job))
    const hit = events.find(
      (e) => e.event === 'limit_hit' && e.job === from.job && e.source === 'stated' && e.until !== undefined
    )
    let resets = ''
    if (hit) {
      const ms = Date.parse(String(hit.until))
      if (!Number.isNaN(ms)) resets = ` (resets ${formatLocalHM(ms)})`
    }
    fallbacks.push(
      `FALLBACK ${fh}/${fm} ${String(end?.outcome ?? 'unknown')}${resets} -> ${String(to.harness)}/${String(to.model)}. Tell the user, then run: fanout ack ${finalJob}`
    )
  }
  lines.push(...fallbacks, ...retries)
  const catalog = loadCatalog().rows
  for (const s of starts) {
    if (s.billing !== 'paid' && s.billing !== 'per_call') continue
    const end = ends.get(String(s.job))
    const measured = end?.cost_source === 'computed'
    const detail = String(end?.detail ?? '')
    const workerLog = detail === 'orphaned lease' || detail.startsWith('interrupted by')
    const row = catalog.find((r) => r.harness === String(s.harness) && r.model === String(s.model))
    const line: CostLine =
      s.billing === 'paid'
        ? {
            harness: String(s.harness),
            model: String(s.model),
            billing: 'paid',
            ...(typeof s.cost_est_usd === 'number' ? { estUsd: s.cost_est_usd } : {}),
            ...(typeof end?.cost_usd === 'number' ? { actualUsd: end.cost_usd as number } : {}),
            measured,
            basis: workerLog ? 'computed from the worker log' : 'computed from tokens'
          }
        : {
            harness: String(s.harness),
            model: String(s.model),
            billing: 'per_call',
            ...(typeof s.cost_est_mc === 'number' ? { estMc: s.cost_est_mc } : {}),
            ...(typeof s.calls_est === 'number' ? { estCalls: s.calls_est } : {}),
            rate: row?.priceCall ?? 0,
            ...(typeof end?.cost_mc === 'number' ? { actualMc: end.cost_mc as number } : {}),
            ...(typeof end?.calls === 'number' ? { actualCalls: end.calls as number } : {}),
            measured,
            basis: 'counted from proxy log'
          }
    lines.push(costLineText(line, finalJob))
  }
  for (const n of extra?.notes ?? []) lines.push(n)
  const workspace = String(final.workspace ?? '')
  if (workspace.includes('/worktrees/')) lines.push(`WORKTREE=${workspace}`)
  const patch = join(dataDir(), 'patches', `${finalJob}.patch`)
  if (existsSync(patch)) lines.push(`PATCH=${patch}`)
  let failed = extra?.failedText
  if (failed === undefined && outcome !== 'ok') {
    const detail = String(finalEnd?.detail ?? '')
    if (detail !== 'orphaned lease' && !detail.startsWith('interrupted by')) {
      if (outcome === 'job_error') {
        failed = `FAILED job_error: the chunk is too large or malformed for this model; split it, or run: fanout run --escalate-from ${finalJob}`
      } else if (outcome === 'no_effect') {
        failed = `FAILED no_effect: the worker exited 0 but changed no file; re-brief, or run: fanout run --escalate-from ${finalJob}`
      } else {
        const triedText = starts
          .map(
            (s) => `${String(s.harness)}/${String(s.model)} (${String(ends.get(String(s.job))?.outcome ?? 'unknown')})`
          )
          .join(', ')
        failed = `FAILED all candidates exhausted. Tried: ${triedText}`
      }
    }
  }
  if (failed) lines.push(failed)
  return lines.join('\n')
}

export function readWorkerLog(job: string): string | undefined {
  try {
    return readFileSync(join(dataDir(), 'logs', `${job}.log`), 'utf8')
  } catch {
    return undefined
  }
}
