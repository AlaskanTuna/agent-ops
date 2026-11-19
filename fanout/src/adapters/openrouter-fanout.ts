import type { BuildInput, BuiltCommand, Classified, ModelInfo, Preflight, RunOutput } from './types'
import { SkipCandidate } from './types'
import { ClaudeCliAdapter, type ClaudeCliConfig } from './claude-cli'
import { modelIds, proxyModels, readProxyConfig, upstreamOf, UNVERIFIED_UPSTREAM, ensureProxy } from './proxy'
import { isKnownAnyUpstream, upstreamClass } from '../dataclass'
import type { Rule } from '../classify'

import openRouterFanoutJson from '../../patterns/openrouter-fanout.json'

function openRouterFanoutRules(): Rule[] {
  try {
    const rules = (openRouterFanoutJson as { rules: Rule[] }).rules
    return Array.isArray(rules) ? rules : []
  } catch {
    return []
  }
}

const openRouterFanoutConfig: ClaudeCliConfig = {
  name: 'openrouter-fanout',
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

function openRouterAliases(): string[] {
  try {
    return (
      readProxyConfig()
        .providers.find((p) => p.name === 'openrouter')
        ?.models.map((m) => m.alias ?? m.name) ?? []
    )
  } catch {
    return []
  }
}

interface OpenRouterPrice {
  priceIn?: number
  priceOut?: number
}

function roundPrice(perMillion: number): number | undefined {
  if (!Number.isFinite(perMillion)) return undefined
  return Math.round(perMillion * 1e4) / 1e4
}

// The public OpenRouter model list prices in USD per token; the catalog
// prices per million, so multiply by 1e6. Unpriced models stay unpriced.
async function openRouterPrices(): Promise<Map<string, OpenRouterPrice>> {
  const out = new Map<string, OpenRouterPrice>()
  const url = process.env.FANOUT_OPENROUTER_URL ?? 'https://openrouter.ai/api/v1/models'
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) return out
    const body = (await res.json()) as { data?: unknown }
    if (!Array.isArray(body?.data)) return out
    for (const item of body.data) {
      if (typeof item !== 'object' || item === null) continue
      const id = (item as Record<string, unknown>).id
      if (typeof id !== 'string' || id === '') continue
      const pricing = (item as Record<string, unknown>).pricing
      if (typeof pricing !== 'object' || pricing === null) continue
      const p = pricing as Record<string, unknown>
      const priceIn = typeof p.prompt === 'string' ? roundPrice(Number(p.prompt) * 1e6) : undefined
      const priceOut = typeof p.completion === 'string' ? roundPrice(Number(p.completion) * 1e6) : undefined
      if (priceIn !== undefined || priceOut !== undefined) out.set(id, { priceIn, priceOut })
    }
  } catch {
    // a missing key or a down API keeps old values; discovery reports it
  }
  return out
}

export class OpenRouterFanoutAdapter extends ClaudeCliAdapter {
  constructor() {
    super(openRouterFanoutConfig, openRouterFanoutRules())
  }

  override build(i: BuildInput): BuiltCommand {
    let aliases: string[]
    try {
      aliases = openRouterAliases()
    } catch {
      throw new SkipCandidate('openrouter-fanout: proxy config unreadable')
    }
    if (!aliases.includes(i.model)) throw new SkipCandidate(`openrouter-fanout: ${i.model} is not an openrouter alias`)
    if (!ensureProxy()) throw new SkipCandidate('openrouter-fanout: proxy not reachable')
    return super.build(i)
  }

  upstream(model: string): string | undefined {
    // The data class comes from the upstream model name in the config, never
    // from the alias. An upstream that is not the upstream cell of an any
    // catalog row (a config edit, an unknown OpenRouter row, an unreadable
    // config) is unverified, and unverified means public-only.
    let raw: string | undefined
    try {
      raw = upstreamOf('openrouter', model)
    } catch {
      return UNVERIFIED_UPSTREAM
    }
    if (raw === undefined) return undefined
    try {
      return isKnownAnyUpstream(raw) ? raw : UNVERIFIED_UPSTREAM
    } catch {
      return UNVERIFIED_UPSTREAM
    }
  }

  override classify(r: RunOutput, nowMs: number): Classified {
    if (r.timedOut) return { outcome: 'timeout' }
    if (r.exit === 124) return { outcome: 'worker_error', pattern: 'cf-exit-124' }
    return super.classify(r, nowMs)
  }

  override async listModels(): Promise<ModelInfo[]> {
    const prices = await openRouterPrices()
    return openRouterAliases().map((model) => {
      const info: ModelInfo = { model, billing: 'paid' }
      let raw: string | undefined
      try {
        raw = upstreamOf('openrouter', model)
      } catch {
        raw = undefined
      }
      if (raw !== undefined) {
        const price = prices.get(raw)
        if (price?.priceIn !== undefined) info.priceIn = price.priceIn
        if (price?.priceOut !== undefined) info.priceOut = price.priceOut
        try {
          if (upstreamClass(raw) === 'public-only') info.dataClass = 'public-only'
        } catch {
          // class defaults to any; routing re-checks through upstream()
        }
      }
      return info
    })
  }

  override async preflight(o?: { quick?: boolean }): Promise<Preflight> {
    if (!Bun.which(this.binary)) return { ok: false, outcome: 'model_unavailable', detail: 'claude not found on PATH' }
    let aliases: string[]
    try {
      readProxyConfig()
      aliases = openRouterAliases()
    } catch {
      return { ok: false, outcome: 'auth_error', detail: 'openrouter-fanout: proxy config unreadable' }
    }
    if (o?.quick) return { ok: true }
    if (!ensureProxy())
      return { ok: false, outcome: 'model_unavailable', detail: 'openrouter-fanout: proxy not reachable' }
    const live = new Set(modelIds(await proxyModels()))
    if (aliases.some((a) => live.has(a))) return { ok: true }
    return {
      ok: false,
      outcome: 'model_unavailable',
      detail: 'openrouter-fanout: no openrouter alias is listed by the proxy'
    }
  }
}
