import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadCatalog, type CatalogRow } from '../catalog'
import { DAY_MS, nowIso, nowMs } from '../clock'
import { appendEvent } from '../events'
import { newId } from '../ulid'
import { homeDir, autoCatalogPath } from '../paths'
import { normalizeBenchmarkName, readBenchmarksDoc, writeBenchmarksDoc } from '../benchmarks'
import { registerStep, StepSkipped, type StepCtx } from './index'

const DEFAULT_AA_URL = 'https://artificialanalysis.ai/api/v2/language/models/free'
const MAX_PAGES = 5
const DUE_MS = DAY_MS

function secretsFile(): string {
  return process.env.FANOUT_SECRETS ?? join(homeDir(), '.config', 'tolong', 'secrets.env')
}

/** The key travels in the process, never through a shell: env first, else parsed (not sourced). */
export function readAaKey(): string | undefined {
  const fromEnv = process.env.AA_API_KEY
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  let text: string
  try {
    text = readFileSync(secretsFile(), 'utf8')
  } catch {
    return undefined
  }
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m || m[1] !== 'AA_API_KEY') continue
    let v = m[2]
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1)
    }
    if (v !== '') return v
  }
  return undefined
}

function timeoutS(): number {
  const raw = Number(process.env.FANOUT_AA_TIMEOUT_S ?? '')
  return Number.isFinite(raw) && raw > 0 ? raw : 20
}

function aaUrl(): string {
  const base = process.env.FANOUT_AA_URL || DEFAULT_AA_URL
  return base
}

function pageUrl(page: number): string {
  const base = aaUrl()
  return `${base}${base.includes('?') ? '&' : '?'}page=${page}`
}

async function fetchJson(url: string, key: string): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutS() * 1000)
  if (timer.unref) timer.unref()
  try {
    const res = await fetch(url, { headers: { 'x-api-key': key }, signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    try {
      return await res.json()
    } catch {
      throw new Error('invalid JSON')
    }
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || ctrl.signal.aborted)) throw new Error('timeout')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

interface AaNumbers {
  slug?: string
  name?: string
  intel?: number
  priceIn?: number
  priceOut?: number
}

function itemNumbers(item: unknown): AaNumbers {
  if (item === null || typeof item !== 'object') return {}
  const o = item as Record<string, unknown>
  const ev =
    o.evaluations !== null && typeof o.evaluations === 'object' ? (o.evaluations as Record<string, unknown>) : {}
  const pr = o.pricing !== null && typeof o.pricing === 'object' ? (o.pricing as Record<string, unknown>) : {}
  const out: AaNumbers = {}
  if (typeof o.slug === 'string') out.slug = o.slug
  if (typeof o.name === 'string') out.name = o.name
  const intel = ev.artificial_analysis_intelligence_index
  if (typeof intel === 'number' && Number.isFinite(intel)) out.intel = intel
  const priceIn = pr.price_1m_input_tokens
  if (typeof priceIn === 'number' && Number.isFinite(priceIn)) out.priceIn = priceIn
  const priceOut = pr.price_1m_output_tokens
  if (typeof priceOut === 'number' && Number.isFinite(priceOut)) out.priceOut = priceOut
  return out
}

const EFFORT_SUFFIX = /-(minimal|low|medium|high|xhigh|max|non-reasoning|reasoning)$/

function indexRows(
  rows: CatalogRow[],
  extra: { harness: string; model: string; aaSlug?: string; aliases: string[] }[]
): { bySlug: Map<string, string[]>; byName: Map<string, string[]> } {
  const bySlug = new Map<string, string[]>()
  const byName = new Map<string, string[]>()
  const add = (harness: string, model: string, aaSlug: string | undefined, aliases: string[]) => {
    const key = `${harness}/${model}`
    if (aaSlug) {
      const list = bySlug.get(aaSlug) ?? []
      if (!list.includes(key)) list.push(key)
      bySlug.set(aaSlug, list)
    }
    const names = new Set([model, ...aliases, ...(aaSlug ? [aaSlug] : [])])
    for (const n of names) {
      const norm = normalizeBenchmarkName(n)
      if (!norm) continue
      const list = byName.get(norm) ?? []
      if (!list.includes(key)) list.push(key)
      byName.set(norm, list)
    }
  }
  for (const row of rows) add(row.harness, row.model, row.aaSlug, row.aliases)
  // Unpriced auto rows never survive catalog validation, so index their raw
  // entries too: they are exactly the rows AA prices are meant to rescue.
  for (const e of extra) add(e.harness, e.model, e.aaSlug, e.aliases)
  return { bySlug, byName }
}

/** Raw auto-catalog entries, without validation: priced or not. */
function readRawAutoRows(): { harness: string; model: string; aaSlug?: string; aliases: string[] }[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(autoCatalogPath(), 'utf8')) as unknown
  } catch {
    return []
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const rows = (parsed as { rows?: unknown }).rows
  if (!Array.isArray(rows)) return []
  const out: { harness: string; model: string; aaSlug?: string; aliases: string[] }[] = []
  for (const r of rows) {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) continue
    const o = r as Record<string, unknown>
    if (typeof o.harness !== 'string' || typeof o.model !== 'string' || !o.harness || !o.model) continue
    const aliases =
      typeof o.aliases === 'string'
        ? o.aliases
            .split('|')
            .map((s) => s.trim())
            .filter(Boolean)
        : Array.isArray(o.aliases)
          ? o.aliases.filter((a): a is string => typeof a === 'string')
          : []
    out.push({
      harness: o.harness,
      model: o.model,
      ...(typeof o.aa_slug === 'string' && o.aa_slug ? { aaSlug: o.aa_slug } : {}),
      aliases
    })
  }
  return out
}

export async function runBenchmarks(ctx: StepCtx): Promise<string> {
  const now = nowMs()
  const existing = readBenchmarksDoc()
  const refreshed = existing?.refreshed_at ? Date.parse(existing.refreshed_at) : NaN
  if (Number.isFinite(refreshed) && now - refreshed <= DUE_MS) {
    throw new StepSkipped(`refreshed ${Math.floor((now - refreshed) / 3600_000)}h ago`)
  }
  const key = readAaKey()
  if (!key) {
    ctx.updateStatus({ benchmarks_note: 'AA_API_KEY missing' })
    throw new StepSkipped('no AA_API_KEY')
  }
  const { rows } = loadCatalog()
  const { bySlug, byName } = indexRows(rows, readRawAutoRows())
  const matched = new Map<string, AaNumbers>()
  const exactHit = new Set<string>()
  let version: number | undefined
  let pages = 0
  try {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const body = (await fetchJson(pageUrl(page), key)) as Record<string, unknown>
      if (body === null || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.data)) {
        throw new Error('invalid JSON')
      }
      pages += 1
      if (version === undefined && typeof body.intelligence_index_version === 'number') {
        version = body.intelligence_index_version
      }
      for (const raw of body.data) {
        const item = itemNumbers(raw)
        const exact =
          (item.slug !== undefined ? bySlug.get(item.slug) : undefined) ??
          (item.name !== undefined ? byName.get(normalizeBenchmarkName(item.name)) : undefined)
        if (exact) {
          for (const t of exact) {
            matched.set(t, item)
            exactHit.add(t)
          }
          continue
        }
        // AA lists one row per reasoning effort ("gpt-6-1-sol-xhigh"); the
        // catalog names the model once. Match on the slug without its effort
        // suffix and keep the strongest variant, unless an exact row matched.
        const base = item.slug?.replace(EFFORT_SUFFIX, '')
        const variants = base && base !== item.slug ? byName.get(normalizeBenchmarkName(base)) : undefined
        if (!variants) continue
        for (const t of variants) {
          if (exactHit.has(t)) continue
          const prev = matched.get(t)
          if (!prev || (item.intel ?? -1) > (prev.intel ?? -1)) matched.set(t, item)
        }
      }
      const pagination =
        body.pagination !== null && typeof body.pagination === 'object' && !Array.isArray(body.pagination)
          ? (body.pagination as Record<string, unknown>)
          : {}
      if (pagination.has_more !== true) break
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    ctx.updateStatus({ benchmarks_note: detail })
    throw err
  }
  if (matched.size === 0) {
    ctx.updateStatus({ benchmarks_note: 'no rows matched' })
    throw new Error('no rows matched')
  }
  const asOf = nowIso().slice(0, 10)
  const stamped = nowIso()
  const doc = readBenchmarksDoc() ?? { values: {} }
  const values = doc.values ?? {}
  for (const [rowKey, item] of matched) {
    const entry: Record<string, unknown> = { ...values[rowKey] }
    const metrics: [string, number | undefined][] = [
      ['aa_intel', item.intel],
      ['aa_price_in', item.priceIn],
      ['aa_price_out', item.priceOut]
    ]
    for (const [metric, value] of metrics) {
      if (value === undefined) continue
      entry[metric] = value
      appendEvent({
        v: 1,
        ts: stamped,
        event: 'benchmark',
        id: newId(),
        model: rowKey,
        source: 'aa',
        metric,
        value,
        as_of: asOf
      })
    }
    entry.as_of = asOf
    values[rowKey] = entry
  }
  const next = { values, refreshed_at: stamped, ...(version !== undefined ? { aa_index_version: version } : {}) }
  writeBenchmarksDoc(next)
  ctx.updateStatus({ benchmarks_refreshed_at: stamped, benchmarks_note: null })
  return `${matched.size} models from ${pages} pages`
}

export function registerBenchmarksStep(): void {
  registerStep('benchmarks', runBenchmarks)
}
