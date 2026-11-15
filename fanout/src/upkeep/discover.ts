import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { adapterFor } from '../adapters/index'
import type { Billing, ModelInfo } from '../adapters/types'
import { loadCatalog } from '../catalog'
import { nowIso, LEDGER_WINDOW_MS, nowMs } from '../clock'
import { appendEvent, readEvents } from '../events'
import { dataDir } from '../paths'
import { newId } from '../ulid'
import { registerStep, type StepCtx } from './index'
import { appendLearned, readLearned } from '../state'

export function normalizeName(name: string): string {
  let s = name.toLowerCase()
  const slash = s.indexOf('/')
  if (slash >= 0) s = s.slice(slash + 1)
  return s.replace(/[^a-z0-9]/g, '')
}

interface BenchmarkEntry {
  name: string
  intel?: number
}

function readBenchmarks(): BenchmarkEntry[] {
  const out: BenchmarkEntry[] = []
  const path = join(dataDir(), 'learned', 'benchmarks.json')
  if (!existsSync(path)) return out
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { models?: unknown } | unknown[]
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { models?: unknown }).models)
        ? (parsed as { models: unknown[] }).models
        : []
    for (const m of list) {
      if (m === null || typeof m !== 'object') continue
      const o = m as Record<string, unknown>
      if (typeof o.name !== 'string') continue
      const entry: BenchmarkEntry = { name: o.name }
      if (typeof o.aa_intel === 'number' && Number.isFinite(o.aa_intel)) entry.intel = o.aa_intel
      out.push(entry)
    }
  } catch {
    // corrupt benchmarks are ignored; discovery still tiers by price
  }
  return out
}

function benchmarkIntel(model: string, benchmarks: BenchmarkEntry[]): number | undefined {
  const want = normalizeName(model)
  for (const b of benchmarks) {
    if (b.intel === undefined) continue
    if (normalizeName(b.name) === want) return b.intel
  }
  return undefined
}

function autoTier(info: ModelInfo, benchmarks: BenchmarkEntry[]): 1 | 2 | 3 {
  const intel = benchmarkIntel(info.model, benchmarks)
  if (intel !== undefined) {
    if (intel < 35) return 1
    if (intel > 52) return 3
    return 2
  }
  if (typeof info.priceOut === 'number' && Number.isFinite(info.priceOut)) {
    if (info.priceOut <= 0.6) return 1
    if (info.priceOut <= 8) return 2
    return 3
  }
  return 2
}

function defaultBilling(harness: string, model: string): Billing {
  if (harness === 'codex' || harness === 'agy') return 'subscription'
  if (harness === 'meta' || harness === 'river' || harness === 'claude-fanout') return 'paid'
  if (harness === 'modelscope') return 'per_call'
  if (harness === 'opencode') {
    if (model.startsWith('opencode/') && model.endsWith('-free')) return 'free'
    if (model.startsWith('opencode-go/')) return 'subscription'
    return 'paid'
  }
  return 'subscription'
}

function defaultDataClass(harness: string, model: string): 'any' | 'public-only' {
  if (/contributor|:free|stealth\//.test(model)) return 'public-only'
  if (harness === 'opencode' && model.startsWith('opencode/') && model.endsWith('-free')) return 'public-only'
  return 'any'
}

function readIgnore(): RegExp[] {
  const out: RegExp[] = []
  try {
    const text = readFileSync(new URL('../../catalog/discovery-ignore.txt', import.meta.url), 'utf8')
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      try {
        out.push(new RegExp(t))
      } catch {
        // a bad ignore line never stops discovery
      }
    }
  } catch {
    // a missing ignore file means nothing is ignored
  }
  return out
}

function autoPath(): string {
  return join(dataDir(), 'learned', 'catalog.auto.json')
}

function readAutoRows(): Record<string, string>[] {
  try {
    if (!existsSync(autoPath())) return []
    const parsed = JSON.parse(readFileSync(autoPath(), 'utf8')) as { rows?: Record<string, unknown>[] }
    if (!Array.isArray(parsed.rows)) return []
    return parsed.rows as Record<string, string>[]
  } catch {
    return []
  }
}

function writeAutoRows(rows: Record<string, string>[]): void {
  mkdirSync(join(dataDir(), 'learned'), { recursive: true, mode: 0o700 })
  const tmp = `${autoPath()}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ rows }) + '\n', { mode: 0o600 })
  renameSync(tmp, autoPath())
}

interface Listed {
  harness: string
  models: ModelInfo[]
  failed: string | undefined
}

async function listHarness(harness: string): Promise<Listed> {
  try {
    const models = await adapterFor(harness).listModels()
    return { harness, models, failed: undefined }
  } catch (err) {
    return { harness, models: [], failed: err instanceof Error ? err.message : String(err) }
  }
}

export async function runDiscover(): Promise<string> {
  const { rows } = loadCatalog()
  const harnesses = [...new Set(rows.map((r) => r.harness))].sort()
  const catalogKeys = new Set(rows.map((r) => `${r.harness}/${r.model}`))
  const listed = await Promise.all(harnesses.map((h) => listHarness(h)))
  const failed = listed.filter((l) => l.failed !== undefined)
  const ignore = readIgnore()
  const benchmarks = readBenchmarks()
  const learned = readLearned()
  const events = readEvents(nowMs() - LEDGER_WINDOW_MS)
  const seenGone = new Set<string>()
  for (const e of events) {
    if (e.event === 'model_gone' && typeof e.harness === 'string' && typeof e.model === 'string') {
      seenGone.add(`${e.harness}/${e.model}`)
    }
  }

  let added = 0
  let gone = 0
  let back = 0
  const auto = readAutoRows()
  const autoByKey = new Map(auto.map((r) => [`${r.harness}/${r.model}`, r]))
  const newKeys = new Set<string>()

  for (const l of listed) {
    if (l.failed !== undefined) continue
    if (l.models.length === 0) continue
    const seen = new Set<string>()
    for (const info of l.models) {
      const key = `${l.harness}/${info.model}`
      if (ignore.some((re) => re.test(key))) continue
      seen.add(key)
      if (catalogKeys.has(key)) continue
      if (autoByKey.has(key)) continue
      const billing = info.billing ?? defaultBilling(l.harness, info.model)
      const tier = autoTier(info, benchmarks)
      const row: Record<string, string> = {
        harness: l.harness,
        model: info.model,
        efforts: (info.efforts ?? []).join('|'),
        tier: String(tier),
        billing,
        price_in: info.priceIn !== undefined ? String(info.priceIn) : '',
        price_cached: info.priceCached !== undefined ? String(info.priceCached) : '',
        price_out: info.priceOut !== undefined ? String(info.priceOut) : '',
        price_call: info.priceCall !== undefined ? String(info.priceCall) : billing === 'per_call' ? '2' : '',
        min_brief_bytes: '',
        data_class: info.dataClass ?? defaultDataClass(l.harness, info.model),
        status: 'trial',
        family: info.model,
        aliases: '',
        aa_slug: '',
        climb: '',
        upstream: '',
        note: ''
      }
      auto.push(row)
      autoByKey.set(key, row)
      newKeys.add(key)
      added += 1
      appendEvent({
        v: 1,
        ts: nowIso(),
        event: 'model_seen',
        id: newId(),
        harness: l.harness,
        model: info.model
      })
      appendEvent({
        v: 1,
        ts: nowIso(),
        event: 'tier_set',
        id: newId(),
        harness: l.harness,
        model: info.model,
        tier,
        source: 'auto'
      })
    }
    for (const key of catalogKeys) {
      if (!key.startsWith(`${l.harness}/`)) continue
      if (seen.has(key)) {
        if (learned.gone.has(key)) {
          appendLearned('state.jsonl', { ts: nowIso(), kind: 'back', key })
          back += 1
        }
        continue
      }
      if (learned.gone.has(key) || seenGone.has(key)) continue
      appendEvent({
        v: 1,
        ts: nowIso(),
        event: 'model_gone',
        id: newId(),
        harness: l.harness,
        model: key.slice(l.harness.length + 1)
      })
      appendLearned('state.jsonl', { ts: nowIso(), kind: 'gone', key })
      gone += 1
    }
  }

  if (added > 0) writeAutoRows(auto)
  if (failed.length > 0) {
    throw new Error(
      `discover failed for ${failed.map((f) => `${f.harness}: ${f.failed}`).join('; ')} (${added} new, ${gone} gone)`
    )
  }
  return `${added} new, ${gone} gone, ${back} back`
}

export function registerDiscoverStep(): void {
  registerStep('discover', async (ctx: StepCtx) => {
    const detail = await runDiscover()
    ctx.updateStatus({
      new_models: currentTrialKeys(),
      gone_models: currentGoneKeys()
    })
    return detail
  })
}

function currentTrialKeys(): string[] {
  return readAutoRows()
    .filter((r) => r.status === 'trial')
    .map((r) => `${r.harness}/${r.model}`)
    .sort()
}

function currentGoneKeys(): string[] {
  return [...readLearned().gone].sort()
}
