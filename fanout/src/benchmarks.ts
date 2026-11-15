import seedJson from '../catalog/benchmarks.seed.json'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CatalogRow } from './catalog'
import { dataDir } from './paths'

/** Benchmark scores by `<harness>/<model>`, then metric name. */
export type BenchmarkMap = Record<string, Record<string, number>>

export function normalizeBenchmarkName(name: string): string {
  let s = name.toLowerCase()
  const slash = s.indexOf('/')
  if (slash >= 0) s = s.slice(slash + 1)
  return s.replace(/[^a-z0-9]/g, '')
}

function copyNumbers(src: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (src === null || typeof src !== 'object' || Array.isArray(src)) return out
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
  }
  return out
}

export interface BenchmarksDoc {
  refreshed_at?: string
  aa_index_version?: number
  values: Record<string, Record<string, unknown>>
}

function docPath(): string {
  return join(dataDir(), 'learned', 'benchmarks.json')
}

export function readBenchmarksDoc(): BenchmarksDoc | undefined {
  if (!existsSync(docPath())) return undefined
  try {
    const parsed = JSON.parse(readFileSync(docPath(), 'utf8')) as Partial<BenchmarksDoc>
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const values: Record<string, Record<string, unknown>> = {}
    if (parsed.values !== null && typeof parsed.values === 'object' && !Array.isArray(parsed.values)) {
      for (const [k, v] of Object.entries(parsed.values)) {
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          values[k] = v as Record<string, unknown>
        }
      }
    }
    const doc: BenchmarksDoc = { values }
    if (typeof parsed.refreshed_at === 'string') doc.refreshed_at = parsed.refreshed_at
    if (typeof parsed.aa_index_version === 'number' && Number.isFinite(parsed.aa_index_version)) {
      doc.aa_index_version = parsed.aa_index_version
    }
    return doc
  } catch {
    return undefined
  }
}

export function writeBenchmarksDoc(doc: BenchmarksDoc): void {
  const dir = join(dataDir(), 'learned')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, `benchmarks.json.${process.pid}.tmp`)
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, docPath())
}

/**
 * Catalog keys matching a benchmark name: `normalize(name)` against the
 * normalised aliases, `aa_slug` or model id.
 */
export function matchRowKeys(rows: CatalogRow[], name: string): string[] {
  const want = normalizeBenchmarkName(name)
  if (!want) return []
  const out: string[] = []
  for (const row of rows) {
    const key = `${row.harness}/${row.model}`
    const names = new Set([row.model, ...row.aliases, ...(row.aaSlug ? [row.aaSlug] : [])])
    for (const n of names) {
      if (normalizeBenchmarkName(n) === want) {
        out.push(key)
        break
      }
    }
  }
  return out
}

/**
 * Layers: `catalog/benchmarks.seed.json`, then `learned/benchmarks.json`
 * overriding it per metric. Never throws: benchmarks never break a run.
 */
export function readBenchmarks(): BenchmarkMap {
  const out: BenchmarkMap = {}
  try {
    const seed = seedJson as Record<string, unknown>
    if (seed !== null && typeof seed === 'object' && !Array.isArray(seed)) {
      for (const [k, v] of Object.entries(seed)) {
        const m = copyNumbers(v)
        if (Object.keys(m).length > 0) out[k] = m
      }
    }
  } catch {
    // a missing or corrupt seed means no seed layer
  }
  try {
    const doc = readBenchmarksDoc()
    if (doc) {
      for (const [k, v] of Object.entries(doc.values)) {
        const m = copyNumbers(v)
        if (Object.keys(m).length === 0) continue
        out[k] = { ...(out[k] ?? {}), ...m }
      }
    }
  } catch {
    // a corrupt learned file means no learned layer
  }
  return out
}
