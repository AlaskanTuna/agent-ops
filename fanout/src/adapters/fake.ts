import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  Adapter,
  BuildInput,
  BuiltCommand,
  Classified,
  ModelInfo,
  Outcome,
  Preflight,
  RunOutput,
  Usage
} from './types'
import { SkipCandidate } from './types'
import type { Rule } from '../classify'

import fakeJson from '../../tests/fixtures/patterns/fake.json'

export function fakeRules(): Rule[] {
  try {
    const rules = (fakeJson as { rules: Rule[] }).rules
    return Array.isArray(rules) ? rules : []
  } catch {
    return []
  }
}

export class FakeAdapter implements Adapter {
  readonly name: string
  envAllow = ['FAKE_*']
  readonly rules: Rule[] = fakeRules()

  constructor(harness: string) {
    this.name = harness
  }

  upstream(model: string): string | undefined {
    try {
      const map = JSON.parse(process.env.FAKE_UPSTREAM ?? '{}') as Record<string, string>
      return map[`${this.name}/${model}`]
    } catch {
      return undefined
    }
  }

  build(i: BuildInput): BuiltCommand {
    const key = `${this.name}/${i.model}`
    const script = readScript()
    const list = script[key]
    const counters = readCounters()
    const idx = counters[key] ?? 0
    const scenario = list ? list[Math.min(idx, list.length - 1)] : 'ok'
    if (process.env.FANOUT_DRYRUN !== '1') {
      counters[key] = idx + 1
      writeCounters(counters)
    }
    const worker = process.env.FANOUT_FAKE_WORKER ?? join(import.meta.dir, '../../tests/helpers/fake-worker.ts')
    const argv = ['bun', worker, scenario, i.briefPath, '--max-turns', String(i.maxTurns)]
    for (const a of i.allow) argv.push('--allow', a)
    const secrets: string[] = []
    const fakeSecret = process.env.FAKE_SECRET
    if (fakeSecret) {
      secrets.push(fakeSecret)
      argv.push('--token', fakeSecret)
    }
    return {
      argv,
      cwd: i.cwd,
      env: {},
      secrets,
      reportPath: undefined
    }
  }

  get proxyBacked(): boolean {
    const list = (process.env.FAKE_PROXY_BACKED ?? '').split(',').map((s) => s.trim())
    return list.includes(this.name)
  }

  async measure(w: { startMs: number; endMs: number; route: string; overlapped: boolean }) {
    void w.startMs
    void w.endMs
    void w.route
    if (w.overlapped) return 'unmeasured' as const
    const n = Number(process.env.FAKE_CALLS)
    if (!Number.isFinite(n) || n < 0) return 'unmeasured' as const
    return { calls: Math.floor(n) }
  }
  classify(_r: RunOutput, _nowMs: number): Classified {
    return { outcome: 'unknown' }
  }

  usage(stdout: string): Usage | undefined {
    const m = /USAGE in=(\d+) cached=(\d+) out=(\d+)/.exec(stdout)
    if (!m) return undefined
    return { tokensIn: Number(m[1]), tokensOut: Number(m[3]), tokensCached: Number(m[2]) }
  }

  async listModels(): Promise<ModelInfo[]> {
    // Test seam: an array lists the `fake` harness; an object maps each
    // harness to its listing. Anything else is a failed listing. Snake_case
    // keys are translated to the ModelInfo contract.
    const raw = process.env.FANOUT_FAKE_MODELS ?? process.env.FAKE_FAKE_MODELS ?? '[]'
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('FANOUT_FAKE_MODELS is not valid JSON')
    }
    const toInfo = (m: unknown): ModelInfo => {
      if (m === null || typeof m !== 'object') throw new Error('FANOUT_FAKE_MODELS entries must be objects')
      const o = m as Record<string, unknown>
      const out: Record<string, unknown> = {}
      const rename: Record<string, string> = {
        price_in: 'priceIn',
        price_cached: 'priceCached',
        price_out: 'priceOut',
        price_call: 'priceCall',
        data_class: 'dataClass',
        min_brief_bytes: 'minBriefBytes',
        aa_slug: 'aaSlug'
      }
      for (const [k, v] of Object.entries(o)) out[rename[k] ?? k] = v
      return out as unknown as ModelInfo
    }
    const toList = (list: unknown, where: string): ModelInfo[] => {
      if (!Array.isArray(list)) throw new Error(`FANOUT_FAKE_MODELS${where} is not an array`)
      return list.map(toInfo)
    }
    if (Array.isArray(parsed)) {
      if (this.name !== 'fake') return []
      return toList(parsed, '')
    }
    if (parsed !== null && typeof parsed === 'object') {
      return toList((parsed as Record<string, unknown>)[this.name] ?? [], `[${this.name}]`)
    }
    throw new Error('FANOUT_FAKE_MODELS must be an array or an object')
  }

  async preflight(_o?: { quick?: boolean }): Promise<Preflight> {
    if (process.env.FAKE_MISSING === this.name)
      return { ok: false, outcome: 'model_unavailable', detail: 'CLI missing' }
    const forced = process.env.FAKE_PREFLIGHT
    if (forced) {
      const idx = forced.indexOf(':')
      const harness = idx >= 0 ? forced.slice(0, idx) : forced
      const outcome = (idx >= 0 ? forced.slice(idx + 1) : 'worker_error') as Outcome
      if (harness === this.name) {
        return { ok: false, outcome, detail: `${this.name} fake preflight failed: ${outcome}` }
      }
    }
    return { ok: true }
  }
}

function scriptPath(): string | undefined {
  return process.env.FANOUT_FAKE_SCRIPT || undefined
}

function readScript(): Record<string, string[]> {
  const p = scriptPath()
  if (!p || !existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, string[]>
  } catch {
    return {}
  }
}

function countersPath(): string {
  return join(process.env.FANOUT_HOME ?? '', 'fake-counters.json')
}

function readCounters(): Record<string, number> {
  try {
    if (!existsSync(countersPath())) return {}
    return JSON.parse(readFileSync(countersPath(), 'utf8')) as Record<string, number>
  } catch {
    return {}
  }
}

function writeCounters(c: Record<string, number>): void {
  try {
    writeFileSync(countersPath(), JSON.stringify(c))
  } catch {
    // counters are best effort
  }
}
