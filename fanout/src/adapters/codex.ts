import { join } from 'node:path'
import type { Adapter, BuildInput, BuiltCommand, Classified, ModelInfo, Preflight, RunOutput, Usage } from './types'
import { classify as sharedClassify, type Rule } from '../classify'

import codexJson from '../../patterns/codex.json'

// No remaining-quota command is known for codex: `codex login status` reports
// auth state only (noted 2026-11-15; revisit if a quota command appears).

function codexRules(): Rule[] {
  try {
    const rules = (codexJson as { rules: Rule[] }).rules
    return Array.isArray(rules) ? rules : []
  } catch {
    return []
  }
}

export class CodexAdapter implements Adapter {
  readonly name = 'codex'
  readonly envAllow = ['CODEX_HOME']
  readonly rules: Rule[] = codexRules()

  build(i: BuildInput): BuiltCommand {
    const argv = ['codex', 'exec', '-C', i.cwd, '-m', i.model]
    if (i.effort) argv.push('-c', `model_reasoning_effort=${i.effort}`)
    argv.push('--ignore-user-config', '--ignore-rules', '--ephemeral')
    if (i.bypass) argv.push('--dangerously-bypass-approvals-and-sandbox')
    else argv.push('--sandbox', 'workspace-write')
    const reportPath = join(i.outDir, `${i.job}.report.md`)
    argv.push('--json', '--output-last-message', reportPath, '-')
    return { argv, cwd: i.cwd, env: {}, stdinPath: i.briefPath, secrets: [], reportPath }
  }

  classify(r: RunOutput, nowMs: number): Classified {
    return sharedClassify(this, r, nowMs)
  }

  usage(stdout: string): Usage | undefined {
    let input = 0
    let cached = 0
    let out = 0
    let seen = false
    for (const line of stdout.split('\n')) {
      const t = line.trim()
      if (!t.startsWith('{')) continue
      try {
        const o = JSON.parse(t) as {
          usage?: { input_tokens?: unknown; cached_input_tokens?: unknown; output_tokens?: unknown }
        }
        const u = o?.usage
        if (typeof u?.input_tokens === 'number' && typeof u?.output_tokens === 'number') {
          input += u.input_tokens
          if (typeof u.cached_input_tokens === 'number') cached += u.cached_input_tokens
          out += u.output_tokens
          seen = true
        }
      } catch {
        // not a worker JSONL line; skip
      }
    }
    if (!seen) return undefined
    return { tokensIn: Math.max(0, input - cached), tokensOut: out, tokensCached: cached }
  }

  async listModels(): Promise<ModelInfo[]> {
    const p = Bun.spawnSync(['codex', 'debug', 'models'], { stdout: 'pipe', stderr: 'ignore' })
    if (p.exitCode !== 0) return []
    try {
      const parsed = JSON.parse(p.stdout.toString()) as { models?: { slug?: unknown }[] }
      if (!Array.isArray(parsed.models)) return []
      const out: ModelInfo[] = []
      for (const m of parsed.models) {
        if (typeof m?.slug === 'string' && m.slug) out.push({ model: m.slug, billing: 'subscription' })
      }
      return out
    } catch {
      return []
    }
  }

  async preflight(o?: { quick?: boolean }): Promise<Preflight> {
    if (!Bun.which('codex')) return { ok: false, outcome: 'model_unavailable', detail: 'codex not found on PATH' }
    if (o?.quick) return { ok: true }
    const p = Bun.spawnSync(['codex', 'login', 'status'], { stdout: 'ignore', stderr: 'pipe' })
    if (p.exitCode === 0) return { ok: true }
    return { ok: false, outcome: 'auth_error', detail: 'codex login status failed' }
  }
}
