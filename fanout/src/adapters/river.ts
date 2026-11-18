import type { BuildInput, BuiltCommand, Classified, ModelInfo, Preflight, RunOutput } from './types'
import { SkipCandidate } from './types'
import { ClaudeCliAdapter, type ClaudeCliConfig } from './claude-cli'
import { modelIds, proxyModels, readProxyConfig, upstreamOf, UNVERIFIED_UPSTREAM, ensureProxy } from './proxy'
import { upstreamClass } from '../dataclass'
import type { Rule } from '../classify'

import riverJson from '../../patterns/river.json'

function riverRules(): Rule[] {
  try {
    const rules = (riverJson as { rules: Rule[] }).rules
    return Array.isArray(rules) ? rules : []
  } catch {
    return []
  }
}

const riverConfig: ClaudeCliConfig = {
  name: 'river',
  baseUrl: () => `http://127.0.0.1:${readProxyConfig().port}`,
  token: () => {
    try {
      return readProxyConfig().token
    } catch {
      return undefined
    }
  },
  missingKeyNote: 'proxy config unreadable; check FANOUT_PROXY_DIR or ~/.cli-proxy-api/config.yaml',
  defaults: { timeoutS: 1500, maxTurns: 120 },
  billing: 'paid'
}

function lastJsonApiStatus(stdout: string): number | undefined {
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const status = (parsed as Record<string, unknown>).api_error_status
        if (typeof status === 'number') return status
        return undefined
      }
    } catch {
      // not JSON; keep scanning older lines
    }
  }
  return undefined
}

function riverAliases(): string[] {
  try {
    return (
      readProxyConfig()
        .providers.find((p) => p.name === 'river')
        ?.models.map((m) => m.alias ?? m.name) ?? []
    )
  } catch {
    return []
  }
}

export class RiverAdapter extends ClaudeCliAdapter {
  constructor() {
    super(riverConfig, riverRules())
  }

  override build(i: BuildInput): BuiltCommand {
    try {
      readProxyConfig()
    } catch {
      throw new SkipCandidate('river: proxy config unreadable')
    }
    if (!ensureProxy()) throw new SkipCandidate('river: proxy not reachable')
    return super.build(i)
  }

  upstream(model: string): string | undefined {
    // River upstreams are class any unless they match the contributor,
    // stealth or :free rule; only an unreadable config hides the row.
    try {
      return upstreamOf('river', model)
    } catch {
      return UNVERIFIED_UPSTREAM
    }
  }

  override classify(r: RunOutput, nowMs: number): Classified {
    if (r.timedOut) return { outcome: 'timeout' }
    // The base maps every 403 to exhausted credit; on river 403 is an auth
    // error. 404 is a retired alias. The concurrency rule below keeps its
    // 30 s backoff instead of the base's bare 429 shortcut.
    const status = lastJsonApiStatus(r.stdout)
    if (status === 401 || status === 403) return { outcome: 'auth_error', scope: 'account' }
    if (status === 404) return { outcome: 'model_unavailable', scope: 'model' }
    if (status === 429 && /model_concurrency/i.test(`${r.stderr}\n${r.stdout}`)) {
      return { outcome: 'rate_limited', scope: 'model', cooldownS: 30, pattern: 'river-concurrency' }
    }
    return super.classify(r, nowMs)
  }

  override async listModels(): Promise<ModelInfo[]> {
    return riverAliases().map((model) => {
      const info: ModelInfo = { model, billing: 'paid' }
      try {
        const raw = upstreamOf('river', model)
        if (raw !== undefined && upstreamClass(raw) === 'public-only') info.dataClass = 'public-only'
      } catch {
        // an unreadable config still lists the alias; routing skips it
      }
      return info
    })
  }

  override async preflight(o?: { quick?: boolean }): Promise<Preflight> {
    if (!Bun.which(this.binary)) return { ok: false, outcome: 'model_unavailable', detail: 'claude not found on PATH' }
    let aliases: string[]
    try {
      readProxyConfig()
      aliases = riverAliases()
    } catch {
      return { ok: false, outcome: 'auth_error', detail: 'river: proxy config unreadable' }
    }
    if (o?.quick) return { ok: true }
    if (!ensureProxy()) return { ok: false, outcome: 'model_unavailable', detail: 'river: proxy not reachable' }
    const live = new Set(modelIds(await proxyModels()))
    if (aliases.some((a) => live.has(a))) return { ok: true }
    return { ok: false, outcome: 'model_unavailable', detail: 'river: no river alias is listed by the proxy' }
  }
}
