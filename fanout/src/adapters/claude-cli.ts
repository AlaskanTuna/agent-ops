import { accessSync, mkdirSync } from 'node:fs'
import { X_OK } from 'node:constants'
import { join } from 'node:path'
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
import { classify as baseClassify, type Rule } from '../classify'

export interface ClaudeCliConfig {
  name: string
  baseUrl: () => string
  token: () => string | undefined
  missingKeyNote: string
  pinModel?: (model: string) => string
  fixEffort?: (model: string, effort: string) => string
  defaultTools?: string[]
  defaults?: { timeoutS?: number; maxTurns?: number }
  billing?: Billing
}

function commandOnPath(cmd: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue
    try {
      accessSync(join(dir, cmd), X_OK)
      return true
    } catch {
      // not here; keep looking
    }
  }
  return false
}

function lastJsonLine(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // not JSON; keep scanning older lines
    }
  }
  return undefined
}

export function denials(stdout: string): number {
  const line = lastJsonLine(stdout)
  const list = line?.permission_denials
  return Array.isArray(list) ? list.length : 0
}

// `claude -p` against another endpoint is the shape of the meta, river and
// openrouter-fanout workers. Subclasses pass their config plus their patterns;
// meta also overrides listModels and preflight.
export class ClaudeCliAdapter implements Adapter {
  readonly name: string
  readonly defaults?: { timeoutS?: number; maxTurns?: number }
  readonly rules: Rule[]
  protected readonly config: ClaudeCliConfig
  protected readonly binary = 'claude'

  constructor(config: ClaudeCliConfig, rules: Rule[]) {
    this.config = config
    this.name = config.name
    this.rules = rules
    if (config.defaults) this.defaults = config.defaults
  }

  build(i: BuildInput): BuiltCommand {
    const token = this.config.token()
    if (!token) throw new SkipCandidate(`${this.config.name}: ${this.config.missingKeyNote}`, 'model_unavailable')
    const model = this.config.pinModel ? this.config.pinModel(i.model) : i.model
    const rawEffort = i.effort ?? ''
    const effort = this.config.fixEffort ? this.config.fixEffort(i.model, rawEffort) : rawEffort
    const argv = ['claude', '-p', '--model', model]
    if (effort !== '') argv.push('--effort', effort)
    argv.push(
      '--permission-mode',
      i.bypass ? 'bypassPermissions' : 'acceptEdits',
      '--max-turns',
      String(i.maxTurns),
      '--output-format',
      'json'
    )
    for (const t of this.config.defaultTools ?? []) argv.push('--allowedTools', t)
    for (const a of i.allow) argv.push('--allowedTools', a)
    // An empty dir: no plugins or hooks ride along, about 5x fewer input tokens.
    const home = process.env.HOME ?? process.env.FANOUT_HOME ?? '/tmp'
    const configDir = join(home, '.claude-fanout')
    try {
      mkdirSync(configDir, { recursive: true })
    } catch {
      // a missing dir never blocks a run; the worker falls back to its default
    }
    return {
      argv,
      cwd: i.cwd,
      env: {
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: this.config.baseUrl(),
        ANTHROPIC_AUTH_TOKEN: token,
        ANTHROPIC_API_KEY: null,
        ANTHROPIC_MODEL: model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        CLAUDE_CODE_SUBAGENT_MODEL: model,
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1048576',
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80',
        ENABLE_TOOL_SEARCH: 'true'
      },
      stdinPath: i.briefPath,
      secrets: [token]
    }
  }

  classify(r: RunOutput, nowMs: number): Classified {
    if (r.timedOut) return { outcome: 'timeout' }
    const line = lastJsonLine(r.stdout)
    if (line) {
      const status = typeof line.api_error_status === 'number' ? line.api_error_status : undefined
      if (status !== undefined || line.is_error === true) {
        if (status === 401) return { outcome: 'auth_error', scope: 'account' }
        if (status === 402 || status === 403) return { outcome: 'credits_exhausted', scope: 'account' }
        if (status === 429) return { outcome: 'rate_limited', scope: 'model' }
        if (status === 413 || status === 422) return { outcome: 'job_error' }
        if (status === 400 && /effort/i.test(JSON.stringify(line))) return { outcome: 'model_unavailable' }
        if (line.subtype === 'error_max_turns') return { outcome: 'job_error' }
      } else if (line.subtype === 'error_max_turns') {
        return { outcome: 'job_error' }
      }
    }
    return baseClassify(this, r, nowMs)
  }

  usage(stdout: string): Usage | undefined {
    const line = lastJsonLine(stdout)
    const mu = line?.modelUsage
    // total_cost_usd is never read: it is fictional for non-Anthropic models.
    if (!mu || typeof mu !== 'object') return undefined
    let tokensIn = 0
    let tokensCached = 0
    let tokensOut = 0
    let found = false
    for (const v of Object.values(mu)) {
      if (!v || typeof v !== 'object') continue
      const o = v as Record<string, unknown>
      if (typeof o.inputTokens !== 'number') continue
      found = true
      tokensIn += o.inputTokens + (typeof o.cacheCreationInputTokens === 'number' ? o.cacheCreationInputTokens : 0)
      tokensCached += typeof o.cacheReadInputTokens === 'number' ? o.cacheReadInputTokens : 0
      tokensOut += typeof o.outputTokens === 'number' ? o.outputTokens : 0
    }
    return found ? { tokensIn, tokensOut, tokensCached } : undefined
  }

  async listModels(): Promise<ModelInfo[]> {
    return []
  }

  async preflight(): Promise<Preflight> {
    if (!this.config.token()) return { ok: false, outcome: 'auth_error', detail: this.config.missingKeyNote }
    if (!commandOnPath(this.binary))
      return { ok: false, outcome: 'model_unavailable', detail: `${this.binary} not found on PATH` }
    return { ok: true }
  }
}
