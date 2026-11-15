import { readFileSync } from 'node:fs'
import type {
  Adapter,
  Billing,
  BuildInput,
  BuiltCommand,
  Classified,
  ModelInfo,
  Preflight,
  RunOutput,
  Usage
} from './types'
import { SkipCandidate } from './types'
import { classify as classifyOut } from '../classify'
import type { Rule } from '../classify'

import opencodeJson from '../../patterns/opencode.json'

const BRIEF_LIMIT_BYTES = 120000

export class OpenCodeAdapter implements Adapter {
  readonly name = 'opencode'
  readonly envAllow = ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR']
  readonly rules: Rule[] = (opencodeJson as { rules: Rule[] }).rules

  build(i: BuildInput): BuiltCommand {
    const briefText = readFileSync(i.briefPath, 'utf8')
    if (Buffer.byteLength(briefText, 'utf8') > BRIEF_LIMIT_BYTES)
      throw new SkipCandidate('brief too large for opencode argv')
    const argv = ['opencode', 'run', '--model', i.model]
    if (i.effort) argv.push('--variant', i.effort)
    // The brief goes on the command line; --dir is a hard boundary and the
    // worktree already keeps inputs inside it.
    argv.push('--dir', i.cwd, briefText)
    return {
      argv,
      cwd: i.cwd,
      env: { OPENCODE_CONFIG_CONTENT: '{"small_model":"opencode/space-bunny-free"}' },
      // An open stdin makes `opencode run` wait forever: close it at once.
      stdinText: '',
      secrets: []
    }
  }

  classify(r: RunOutput, nowMs: number): Classified {
    return classifyOut(this, r, nowMs)
  }

  usage(_stdout: string): Usage | undefined {
    return undefined
  }

  async listModels(): Promise<ModelInfo[]> {
    const p = Bun.spawnSync(['opencode', 'models'], { stdout: 'pipe', stderr: 'ignore' })
    if (p.exitCode !== 0) return []
    const out: ModelInfo[] = []
    for (const token of p.stdout.toString().split(/\s+/)) {
      const line = token.trim()
      if (!line || !line.includes('/')) continue
      let billing: Billing = 'paid'
      if (line.startsWith('opencode/') && line.endsWith('-free')) billing = 'free'
      else if (line.startsWith('opencode-go/')) billing = 'subscription'
      out.push({ model: line, billing })
    }
    return out
  }

  async preflight(o?: { quick?: boolean }): Promise<Preflight> {
    if (!Bun.which('opencode')) return { ok: false, outcome: 'model_unavailable', detail: 'opencode not found on PATH' }
    if (o?.quick) return { ok: true }
    const p = Bun.spawnSync(['opencode', 'models'], { stdout: 'ignore', stderr: 'ignore' })
    if (p.exitCode === 0) return { ok: true }
    return { ok: false, outcome: 'model_unavailable', detail: 'opencode models did not exit 0' }
  }
}
