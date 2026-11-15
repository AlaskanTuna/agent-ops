import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Adapter, BuildInput, BuiltCommand, Classified, ModelInfo, Preflight, RunOutput, Usage } from './types'
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
    counters[key] = idx + 1
    writeCounters(counters)
    const worker = process.env.FANOUT_FAKE_WORKER ?? join(import.meta.dir, '../../tests/helpers/fake-worker.ts')
    return {
      argv: ['bun', worker, scenario, i.briefPath],
      cwd: i.cwd,
      env: {},
      secrets: [],
      reportPath: undefined
    }
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
    try {
      return JSON.parse(process.env.FAKE_FAKE_MODELS ?? '[]') as ModelInfo[]
    } catch {
      return []
    }
  }

  async preflight(_o?: { quick?: boolean }): Promise<Preflight> {
    if (process.env.FAKE_MISSING === this.name)
      return { ok: false, outcome: 'model_unavailable', detail: 'CLI missing' }
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
