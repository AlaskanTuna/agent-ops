import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadCatalog } from '../catalog'
import { nowMs } from '../clock'
import { DUCKDB_MISSING, duckdbJson } from '../duckdb'
import { dataDir } from '../paths'
import { registerCommand } from '../cli'

const HEADER =
  'harness\tmodel\tkind\tjobs\tok\taccepted\trejected\tsuccess_rate\tfallbacks_from\tcost_usd\tcost_mc\tcalls\tcost_per_accepted_usd'

function usage(): string {
  return 'usage: fanout report [--since 30d]'
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0'
  return String(Number(n.toFixed(6)))
}

function num(v: unknown): number {
  // DuckDB encodes wide integers (HUGEINT) as JSON strings.
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return 0
}

interface AggRow {
  harness: string
  model: string
  kind: string
  jobs: number
  ok: number
  accepted: number
  rejected: number
  fallbacks_from: number
  cost_usd: number
  cost_mc: number
  calls: number
}

function successRate(r: { accepted: number; rejected: number }): number {
  const n = r.accepted + r.rejected
  return n === 0 ? 0 : r.accepted / n
}

function costPerAccepted(r: { accepted: number; cost_usd: number }): number {
  return r.accepted === 0 ? 0 : r.cost_usd / r.accepted
}

function line(r: AggRow | ({ harness: string; model: string; kind: string } & Record<string, number>)): string {
  return [
    r.harness,
    r.model,
    r.kind,
    fmt(r.jobs),
    fmt(r.ok),
    fmt(r.accepted),
    fmt(r.rejected),
    fmt(successRate(r as { accepted: number; rejected: number })),
    fmt(r.fallbacks_from),
    fmt(r.cost_usd),
    fmt(r.cost_mc),
    fmt(r.calls),
    fmt(costPerAccepted(r as { accepted: number; cost_usd: number }))
  ].join('\t')
}

export async function runReport(rawArgs: string[]): Promise<number> {
  let sinceDays = 30
  const args = [...rawArgs]
  while (args.length > 0) {
    const a = args.shift()
    if (a === '--since') {
      const m = /^(\d+)d$/.exec(args.shift() ?? '')
      if (!m) {
        console.error(usage())
        return 2
      }
      sinceDays = Number(m[1])
    } else {
      console.error(usage())
      return 2
    }
  }
  try {
    await duckdbJson('SELECT 1 AS ok')
  } catch {
    console.error(DUCKDB_MISSING)
    return 1
  }
  let files: string[] = []
  try {
    files = readdirSync(join(dataDir(), 'events')).filter((f) => f.endsWith('.jsonl'))
  } catch {
    files = []
  }
  let rows: AggRow[] = []
  if (files.length > 0) {
    const template = readFileSync(join(import.meta.dir, '../../sql/report.sql'), 'utf8')
    const cutoff = new Date(nowMs() - sinceDays * 86400_000).toISOString()
    const sql = template
      .replaceAll('__EVENTS_GLOB__', join(dataDir(), 'events', '*.jsonl'))
      .replaceAll('__SINCE_TS__', cutoff)
    let raw: Record<string, unknown>[]
    try {
      raw = await duckdbJson(sql)
    } catch {
      console.error(DUCKDB_MISSING)
      return 1
    }
    rows = raw
      .filter((r) => typeof r.harness === 'string' && typeof r.model === 'string' && typeof r.kind === 'string')
      .map((r) => ({
        harness: r.harness as string,
        model: r.model as string,
        kind: r.kind as string,
        jobs: num(r.jobs),
        ok: num(r.ok),
        accepted: num(r.accepted),
        rejected: num(r.rejected),
        fallbacks_from: num(r.fallbacks_from),
        cost_usd: num(r.cost_usd),
        cost_mc: num(r.cost_mc),
        calls: num(r.calls),
        tokens_in: num(r.tokens_in),
        tokens_cached: num(r.tokens_cached),
        tokens_out: num(r.tokens_out)
      }))
      .map((r) => ({ ...r, cost_usd: backfillCost(r) }))
  }
  console.log(HEADER)
  for (const r of rows) console.log(line(r))
  const total = {
    harness: 'TOTAL',
    model: '',
    kind: '',
    jobs: rows.reduce((a, r) => a + r.jobs, 0),
    ok: rows.reduce((a, r) => a + r.ok, 0),
    accepted: rows.reduce((a, r) => a + r.accepted, 0),
    rejected: rows.reduce((a, r) => a + r.rejected, 0),
    fallbacks_from: rows.reduce((a, r) => a + r.fallbacks_from, 0),
    cost_usd: rows.reduce((a, r) => a + r.cost_usd, 0),
    cost_mc: rows.reduce((a, r) => a + r.cost_mc, 0),
    calls: rows.reduce((a, r) => a + r.calls, 0)
  }
  console.log(line(total))
  return 0
}

// Ledgers written before paid costs landed in job_end carry tokens but no
// cost_usd. Price those from the catalog so old runs still report a cost.
function backfillCost(r: AggRow & { tokens_in: number; tokens_cached: number; tokens_out: number }): number {
  if (r.cost_usd !== 0) return r.cost_usd
  if (r.tokens_in + r.tokens_cached + r.tokens_out === 0) return 0
  const found = loadCatalog().rows.find((c) => c.harness === r.harness && c.model === r.model)
  if (!found || found.billing !== 'paid') return 0
  return (
    (r.tokens_in * (found.priceIn ?? 0) +
      r.tokens_cached * (found.priceCached ?? 0) +
      r.tokens_out * (found.priceOut ?? 0)) /
    1e6
  )
}

registerCommand('report', runReport)
