import { readFileSync } from 'node:fs'
import type { Adapter, BuildInput, BuiltCommand, Classified, ModelInfo, Preflight, RunOutput, Usage } from './types'
import { SkipCandidate } from './types'
import { classify as classifyOut } from '../classify'
import type { Rule } from '../classify'

import agyJson from '../../patterns/agy.json'

const BRIEF_LIMIT_BYTES = 120000

export class AgyAdapter implements Adapter {
  readonly name = 'agy'
  readonly rules: Rule[] = (agyJson as { rules: Rule[] }).rules

  build(i: BuildInput): BuiltCommand {
    const briefText = readFileSync(i.briefPath, 'utf8')
    if (Buffer.byteLength(briefText, 'utf8') > BRIEF_LIMIT_BYTES)
      throw new SkipCandidate('brief too large for agy argv')
    const argv = ['agy', '-p', briefText, '--model', i.model]
    if (i.effort) argv.push('--effort', i.effort)
    argv.push(
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
      '--add-dir',
      i.cwd,
      '--print-timeout',
      `${i.timeoutS}s`
    )
    return { argv, cwd: i.cwd, env: {}, secrets: [] }
  }

  classify(r: RunOutput, nowMs: number): Classified {
    return classifyOut(this, r, nowMs)
  }

  usage(_stdout: string): Usage | undefined {
    return undefined
  }

  async listModels(): Promise<ModelInfo[]> {
    const p = Bun.spawnSync(['agy', 'models'], { stdout: 'pipe', stderr: 'ignore' })
    if (p.exitCode !== 0) return []
    const groups = new Map<string, string[]>()
    for (const token of p.stdout.toString().split(/\s+/)) {
      const m = /^(.+)-(low|medium|high|xhigh|max)$/.exec(token)
      if (!m) continue
      const base = m[1]
      const effort = m[2]
      const list = groups.get(base)
      if (list) {
        if (!list.includes(effort)) list.push(effort)
      } else groups.set(base, [effort])
    }
    return [...groups].map(([model, efforts]) => ({ model, efforts, billing: 'subscription' as const }))
  }

  async preflight(o?: { quick?: boolean }): Promise<Preflight> {
    if (!Bun.which('agy')) return { ok: false, outcome: 'model_unavailable', detail: 'agy not found on PATH' }
    if (o?.quick) return { ok: true }
    const p = Bun.spawnSync(['agy', 'models'], { stdout: 'ignore', stderr: 'ignore' })
    if (p.exitCode === 0) return { ok: true }
    return { ok: false, outcome: 'model_unavailable', detail: 'agy models did not exit 0' }
  }
}
