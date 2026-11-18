import { join } from 'node:path'
import { homeDir } from '../paths'
import { readFileSync } from 'node:fs'
import type { ModelInfo, Preflight } from './types'
import { ClaudeCliAdapter, type ClaudeCliConfig } from './claude-cli'
import type { Rule } from '../classify'

import metaJson from '../../patterns/meta.json'

function metaRules(): Rule[] {
  try {
    const rules = (metaJson as { rules: Rule[] }).rules
    return Array.isArray(rules) ? rules : []
  } catch {
    return []
  }
}

// The key travels in the process, never through a shell: read the environment
// first, else parse (not source) the FANOUT_SECRETS file.
export function readMetaKey(): string | undefined {
  const fromEnv = process.env.META_MODEL_API_KEY
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  // Same default as the meta-fanout skill: CC_META_SECRETS, else the shared secrets file.
  const file =
    process.env.FANOUT_SECRETS ?? process.env.CC_META_SECRETS ?? join(homeDir(), '.config', 'tolong', 'secrets.env')
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m || m[1] !== 'META_MODEL_API_KEY') continue
    let v = m[2]
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1)
    }
    if (v !== '') return v
  }
  return undefined
}

const metaConfig: ClaudeCliConfig = {
  name: 'meta',
  baseUrl: () => process.env.FANOUT_META_URL ?? 'https://api.meta.ai',
  token: readMetaKey,
  missingKeyNote: 'no META_MODEL_API_KEY on file; the user adds it in their own terminal, never in the chat',
  fixEffort: (model, effort) => (model.includes('contributor') && effort === 'max' ? 'xhigh' : effort),
  defaults: { timeoutS: 1500, maxTurns: 120 },
  billing: 'paid'
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function toModelInfo(item: unknown): ModelInfo | undefined {
  const id = typeof item === 'string' ? item : (item as { id?: unknown })?.id
  if (typeof id !== 'string' || !id.startsWith('muse-')) return undefined
  const info: ModelInfo = {
    model: id,
    billing: 'paid',
    dataClass: /contributor|:free|stealth\//.test(id) ? 'public-only' : 'any'
  }
  if (item !== null && typeof item === 'object') {
    const o = item as Record<string, unknown>
    const priceIn = num(o.price_in)
    const priceCached = num(o.price_cached)
    const priceOut = num(o.price_out)
    if (priceIn !== undefined) info.priceIn = priceIn
    if (priceCached !== undefined) info.priceCached = priceCached
    if (priceOut !== undefined) info.priceOut = priceOut
    if (Array.isArray(o.efforts) && o.efforts.every((e): e is string => typeof e === 'string')) {
      info.efforts = o.efforts
    }
  }
  return info
}

export class MetaAdapter extends ClaudeCliAdapter {
  constructor() {
    super(metaConfig, metaRules())
  }

  override async listModels(): Promise<ModelInfo[]> {
    const token = this.config.token()
    if (!token) return []
    let res: Response
    try {
      res = await fetch(`${this.config.baseUrl()}/v1/models`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000)
      })
    } catch {
      return []
    }
    if (!res.ok) return []
    let body: unknown
    try {
      body = await res.json()
    } catch {
      return []
    }
    const items = Array.isArray(body)
      ? body
      : ((body as { data?: unknown })?.data ?? (body as { models?: unknown })?.models)
    if (!Array.isArray(items)) return []
    const out: ModelInfo[] = []
    for (const item of items) {
      const info = toModelInfo(item)
      if (info) out.push(info)
    }
    return out
  }

  override async preflight(o?: { quick?: boolean }): Promise<Preflight> {
    const quick = await super.preflight()
    if (!quick.ok || o?.quick === true) return quick
    // Full preflight never makes an inference call: a plain model-list GET only.
    const token = this.config.token()
    let res: Response
    try {
      res = await fetch(`${this.config.baseUrl()}/v1/models`, {
        headers: { Authorization: `Bearer ${token ?? ''}` },
        signal: AbortSignal.timeout(15000)
      })
    } catch {
      return { ok: false, outcome: 'model_unavailable', detail: 'meta: models endpoint unreachable' }
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, outcome: 'auth_error', detail: `meta: models endpoint refused the key (HTTP ${res.status})` }
    }
    if (!res.ok) {
      return { ok: false, outcome: 'model_unavailable', detail: `meta: models endpoint returned HTTP ${res.status}` }
    }
    return { ok: true }
  }
}
