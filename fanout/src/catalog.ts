import { existsSync, readFileSync } from 'node:fs'
import { parseCsv } from './csv'
import { readBenchmarks, type BenchmarkMap } from './benchmarks'
import type { Billing } from './adapters/types'
import { autoCatalogPath, catalogOverridePath, privateCatalogPath } from './paths'
// @ts-expect-error bun text import: inlined at bundle time, no type declarations
import bundledCsv from '../catalog/catalog.default.csv' with { type: 'text' }
import kindsJson from '../catalog/kinds.json'

export type { Billing }
export type DataClass = 'any' | 'public-only'
export type RowStatus = 'active' | 'trial' | 'retired'

export interface CatalogRow {
  harness: string
  model: string
  efforts: string[]
  tier: 1 | 2 | 3
  billing: Billing
  priceIn?: number
  priceCached?: number
  priceOut?: number
  priceCall?: number
  minBriefBytes: number
  dataClass: DataClass
  status: RowStatus
  family: string
  aliases: string[]
  aaSlug?: string
  climb: string[]
  upstream?: string
  note?: string
}

export interface KindInfo {
  tier: number
  writes: boolean
  prior?: [number, number, number]
}

const BILLINGS: Billing[] = ['subscription', 'free', 'paid', 'per_call']
const STATUSES: RowStatus[] = ['active', 'trial', 'retired']

function num(v: string): number | undefined {
  if (v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function splitPipe(v: string): string[] {
  return v
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
}

function parseRow(raw: Record<string, string>): { row?: CatalogRow; error?: string } {
  const key = `${raw.harness}/${raw.model}`
  const tier = num(raw.tier ?? '')
  if (tier !== 1 && tier !== 2 && tier !== 3) return { error: `${key}: tier must be 1, 2 or 3` }
  const billing = (raw.billing ?? '') as Billing
  if (!BILLINGS.includes(billing)) return { error: `${key}: unknown billing ${raw.billing}` }
  const status = (raw.status ?? '') as RowStatus
  if (!STATUSES.includes(status)) return { error: `${key}: unknown status ${raw.status}` }
  const priceIn = num(raw.price_in ?? '')
  const priceCached = num(raw.price_cached ?? '')
  const priceOut = num(raw.price_out ?? '')
  const priceCall = num(raw.price_call ?? '')
  if (billing === 'paid' && (priceIn === undefined || priceOut === undefined)) {
    return { error: `${key}: paid row needs price_in and price_out` }
  }
  if (billing === 'per_call' && priceCall === undefined) {
    return { error: `${key}: per_call row needs price_call` }
  }
  const dataClass = (raw.data_class ?? '') === '' ? 'any' : raw.data_class
  if (dataClass !== 'any' && dataClass !== 'public-only') {
    return { error: `${key}: unknown data_class ${raw.data_class}` }
  }
  const row: CatalogRow = {
    harness: raw.harness,
    model: raw.model,
    efforts: splitPipe(raw.efforts ?? ''),
    tier,
    billing,
    minBriefBytes: num(raw.min_brief_bytes ?? '') ?? 0,
    dataClass,
    status,
    family: raw.family || raw.model,
    aliases: splitPipe(raw.aliases ?? ''),
    climb: splitPipe(raw.climb ?? '')
  }
  if (priceIn !== undefined) row.priceIn = priceIn
  if (priceCached !== undefined) row.priceCached = priceCached
  if (priceOut !== undefined) row.priceOut = priceOut
  if (priceCall !== undefined) row.priceCall = priceCall
  if (raw.aa_slug) row.aaSlug = raw.aa_slug
  if (raw.upstream) row.upstream = raw.upstream
  if (raw.note) row.note = raw.note
  return { row }
}

function mergeInto(base: CatalogRow, raw: Record<string, string>): void {
  if (raw.efforts !== '' && raw.efforts !== undefined) base.efforts = splitPipe(raw.efforts)
  if (raw.tier !== '' && raw.tier !== undefined) {
    const t = num(raw.tier)
    if (t === 1 || t === 2 || t === 3) base.tier = t
  }
  if (raw.billing !== '' && raw.billing !== undefined && BILLINGS.includes(raw.billing as Billing)) {
    base.billing = raw.billing as Billing
  }
  const priceIn = num(raw.price_in ?? '')
  if (priceIn !== undefined) base.priceIn = priceIn
  const priceCached = num(raw.price_cached ?? '')
  if (priceCached !== undefined) base.priceCached = priceCached
  const priceOut = num(raw.price_out ?? '')
  if (priceOut !== undefined) base.priceOut = priceOut
  const priceCall = num(raw.price_call ?? '')
  if (priceCall !== undefined) base.priceCall = priceCall
  const minBrief = num(raw.min_brief_bytes ?? '')
  if (minBrief !== undefined) base.minBriefBytes = minBrief
  if (raw.data_class === 'any' || raw.data_class === 'public-only') base.dataClass = raw.data_class
  if (raw.status === 'active' || raw.status === 'trial' || raw.status === 'retired') base.status = raw.status
  if (raw.family) base.family = raw.family
  if (raw.aliases !== '' && raw.aliases !== undefined) base.aliases = splitPipe(raw.aliases)
  if (raw.aa_slug) base.aaSlug = raw.aa_slug
  if (raw.climb !== '' && raw.climb !== undefined) base.climb = splitPipe(raw.climb)
  if (raw.upstream) base.upstream = raw.upstream
  if (raw.note) base.note = raw.note
}

function blankRow(harness: string, model: string): CatalogRow {
  return {
    harness,
    model,
    efforts: [],
    tier: 2,
    billing: 'subscription',
    minBriefBytes: 0,
    dataClass: 'any',
    status: 'active',
    family: model,
    aliases: [],
    climb: []
  }
}

function validateFinal(row: CatalogRow): string | undefined {
  const key = `${row.harness}/${row.model}`
  if (row.tier !== 1 && row.tier !== 2 && row.tier !== 3) return `${key}: tier must be 1, 2 or 3`
  if (!BILLINGS.includes(row.billing)) return `${key}: unknown billing ${row.billing}`
  if (!STATUSES.includes(row.status)) return `${key}: unknown status ${row.status}`
  if (row.billing === 'paid' && (row.priceIn === undefined || row.priceOut === undefined)) {
    return `${key}: paid row needs price_in and price_out`
  }
  if (row.billing === 'per_call' && row.priceCall === undefined) {
    return `${key}: per_call row needs price_call`
  }
  return undefined
}

function readAutoRows(): Record<string, string>[] {
  const path = autoCatalogPath()
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { rows?: Record<string, unknown>[] }
    if (!Array.isArray(parsed.rows)) return []
    return parsed.rows.map((r) => {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(r)) {
        if (v === undefined || v === null) out[k] = ''
        else if (Array.isArray(v)) out[k] = v.join('|')
        else out[k] = String(v)
      }
      return out
    })
  } catch {
    return []
  }
}

function readCsvFile(path: string): Record<string, string>[] {
  if (!existsSync(path)) return []
  try {
    return parseCsv(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
}

export interface LoadedCatalog {
  rows: CatalogRow[]
  warnings: string[]
  fatal?: string
}

const PRIVATE_UNREADABLE = 'REFUSED cannot read ~/.config/agent-ops/catalog.csv'

function readPrivateRows(): { rows: Record<string, string>[]; fatal?: string } {
  const path = privateCatalogPath()
  if (!existsSync(path)) return { rows: [] }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { rows: [], fatal: PRIVATE_UNREADABLE }
  }
  let parsed: Record<string, string>[]
  try {
    parsed = parseCsv(text)
  } catch {
    return { rows: [], fatal: PRIVATE_UNREADABLE }
  }
  if (text.trim() !== '' && parsed.length > 0) {
    // Every row shares the header's keys, so the first row tells whether the
    // private file has the key columns at all. Rows with empty values are
    // still skipped row by row, as before.
    if (!('harness' in parsed[0]) || !('model' in parsed[0])) return { rows: [], fatal: PRIVATE_UNREADABLE }
  }
  return { rows: parsed }
}

export function loadCatalog(): LoadedCatalog {
  const warnings: string[] = []
  // Artificial Analysis prices fill only the missing prices of auto rows,
  // before validation, so a newly priced auto row becomes routable.
  // A default or private price is never overridden.
  let bench: BenchmarkMap = {}
  try {
    bench = readBenchmarks()
  } catch {
    bench = {}
  }
  const override = catalogOverridePath()
  const defaultRaw = override ? readCsvFile(override) : parseCsv(bundledCsv)
  const privateRows = readPrivateRows()
  if (privateRows.fatal) return { rows: [], warnings, fatal: privateRows.fatal }
  const layers: { raw: Record<string, string>[]; replace: boolean; silent: boolean }[] = [
    { raw: readAutoRows(), replace: true, silent: true },
    { raw: defaultRaw, replace: true, silent: false },
    { raw: privateRows.rows, replace: false, silent: false }
  ]
  const rows = new Map<string, { row: CatalogRow; specLayer: number }>()
  const wildcards: { raw: Record<string, string>[]; layer: number }[] = []
  layers.forEach(({ raw, replace, silent }, layer) => {
    const layerWildcards: Record<string, string>[] = []
    for (const r of raw) {
      if (!r.harness || !r.model) continue
      if (r.model === '*') {
        layerWildcards.push(r)
        continue
      }
      const key = `${r.harness}/${r.model}`
      if (replace) {
        let raw = r
        if (layer === 0) {
          const b = bench[`${r.harness}/${r.model}`]
          if (b) {
            if ((r.price_in ?? '') === '' && typeof b.aa_price_in === 'number')
              raw = { ...raw, price_in: String(b.aa_price_in) }
            if ((r.price_out ?? '') === '' && typeof b.aa_price_out === 'number') {
              raw = { ...raw, price_out: String(b.aa_price_out) }
            }
          }
        }
        const parsed = parseRow(fullRow(raw))
        if (!parsed.row) {
          if (!silent) warnings.push(`WARN catalog row skipped: ${parsed.error}`)
          continue
        }
        rows.set(key, { row: parsed.row, specLayer: layer })
      } else {
        const t = (r.tier ?? '').trim()
        if (t !== '' && t !== '1' && t !== '2' && t !== '3') {
          warnings.push(`WARN private catalog ${key}: tier ${t} ignored, tier must be 1, 2 or 3`)
        }
        const existing = rows.get(key)
        if (existing) {
          mergeInto(existing.row, r)
          existing.specLayer = layer
        } else {
          const fresh = blankRow(r.harness, r.model)
          mergeInto(fresh, r)
          rows.set(key, { row: fresh, specLayer: layer })
        }
      }
    }
    wildcards.push({ raw: layerWildcards, layer })
  })
  for (const { raw, layer } of wildcards) {
    for (const w of raw) {
      for (const entry of rows.values()) {
        if (entry.row.harness !== w.harness) continue
        if (entry.specLayer >= layer) continue
        mergeInto(entry.row, { ...w, harness: entry.row.harness, model: entry.row.model })
      }
    }
  }
  const out: CatalogRow[] = []
  for (const [key, entry] of rows) {
    const problem = validateFinal(entry.row)
    if (problem) {
      const autoOnly = entry.specLayer === 0
      if (!(autoOnly && /needs price/.test(problem))) warnings.push(`WARN catalog row skipped: ${problem}`)
      continue
    }
    void key
    out.push(entry.row)
  }
  return { rows: out, warnings }
}

function fullRow(r: Record<string, string>): Record<string, string> {
  return {
    harness: r.harness ?? '',
    model: r.model ?? '',
    efforts: r.efforts ?? '',
    tier: r.tier ?? '',
    billing: r.billing ?? '',
    price_in: r.price_in ?? '',
    price_cached: r.price_cached ?? '',
    price_out: r.price_out ?? '',
    price_call: r.price_call ?? '',
    min_brief_bytes: r.min_brief_bytes ?? '',
    data_class: r.data_class ?? '',
    status: r.status ?? '',
    family: r.family ?? '',
    aliases: r.aliases ?? '',
    aa_slug: r.aa_slug ?? '',
    climb: r.climb ?? '',
    upstream: r.upstream ?? '',
    note: r.note ?? ''
  }
}

export function kindInfo(kind: string): KindInfo {
  try {
    const kinds = kindsJson as unknown as Record<string, KindInfo>
    const found = kinds[kind]
    if (found) return found
  } catch {
    // fall through to the edit default
  }
  return { tier: 2, writes: true, prior: [300000, 600000, 30000] }
}
