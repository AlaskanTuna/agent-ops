import { openSync, closeSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { homeDir } from '../paths'

export interface ProxyModelEntry {
  name: string
  alias?: string
}

export interface ProxyProvider {
  name: string
  baseUrl: string
  models: ProxyModelEntry[]
}

export interface ProxyConfig {
  port: number
  token: string
  providers: ProxyProvider[]
}

export interface ProxyModelInfo {
  id?: unknown
  name?: unknown
}

// Fail closed when the proxy cannot be verified: an unknown or unverifiable
// upstream is reported as a stealth model, so the existing contributor /
// stealth / :free rule in upstreamClass() keeps private chunks away from it.
// The value is never the real upstream and never reaches a worker.
export const UNVERIFIED_UPSTREAM = 'stealth/unverified-upstream'

export function proxyDir(): string {
  return process.env.FANOUT_PROXY_DIR ?? join(homeDir(), '.cli-proxy-api')
}

function configPath(): string {
  return join(proxyDir(), 'config.yaml')
}

function isEntry(raw: unknown): raw is { name: unknown; alias?: unknown } {
  return typeof raw === 'object' && raw !== null && 'name' in raw
}

// CLIProxyAPI's real config lists providers under `openai-compatibility`, each
// with `base-url` and `api-key-entries: [{ api-key }]`. Older fixtures use a
// `providers` list with `baseUrl` and `api-keys`. Both normalise to one shape.
export function normalizeProviders(o: Record<string, unknown>): Record<string, unknown>[] | undefined {
  const list = Array.isArray(o['openai-compatibility'])
    ? o['openai-compatibility']
    : Array.isArray(o.providers)
      ? o.providers
      : undefined
  if (!list) return undefined
  return list.map((p) => {
    if (typeof p !== 'object' || p === null) return p as Record<string, unknown>
    const po = { ...(p as Record<string, unknown>) }
    if (po.baseUrl === undefined && typeof po['base-url'] === 'string') po.baseUrl = po['base-url']
    if (po['api-keys'] === undefined && Array.isArray(po['api-key-entries'])) {
      po['api-keys'] = (po['api-key-entries'] as unknown[])
        .map((e) => (typeof e === 'object' && e !== null ? (e as Record<string, unknown>)['api-key'] : undefined))
        .filter((k) => typeof k === 'string' && k !== '')
    }
    return po
  })
}

// The token lives in the parsed file, never in an error: every failure below
// reports only the config path.
export function readProxyConfig(): ProxyConfig {
  const path = configPath()
  const fail = (): Error => new Error(`proxy config unreadable: ${path}`)
  let raw: unknown
  try {
    raw = Bun.YAML.parse(readFileSync(path, 'utf8'))
  } catch {
    throw fail()
  }
  if (typeof raw !== 'object' || raw === null) throw fail()
  const o = raw as Record<string, unknown>
  const port = o.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw fail()
  const keys = o['api-keys']
  if (!Array.isArray(keys) || typeof keys[0] !== 'string' || keys[0] === '') throw fail()
  const providersRaw = normalizeProviders(o)
  if (!providersRaw) throw fail()
  const providers: ProxyProvider[] = []
  for (const p of providersRaw) {
    if (typeof p !== 'object' || p === null) throw fail()
    const po = p as Record<string, unknown>
    if (typeof po.name !== 'string' || po.name === '') throw fail()
    if (!Array.isArray(po.models)) throw fail()
    const models: ProxyModelEntry[] = []
    for (const m of po.models) {
      if (!isEntry(m) || typeof m.name !== 'string' || m.name === '') throw fail()
      const entry: ProxyModelEntry = { name: m.name }
      if (m.alias !== undefined) {
        if (typeof m.alias !== 'string' || m.alias === '') throw fail()
        entry.alias = m.alias
      }
      models.push(entry)
    }
    providers.push({ name: po.name, baseUrl: typeof po.baseUrl === 'string' ? po.baseUrl : '', models })
  }
  return { port, token: keys[0] as string, providers }
}

// The upstream model name for the provider entry whose alias (else name)
// matches, or undefined when the provider or alias is not configured.
export function upstreamOf(provider: string, aliasOrName: string): string | undefined {
  const cfg = readProxyConfig()
  const p = cfg.providers.find((p) => p.name === provider)
  if (!p) return undefined
  return p.models.find((m) => (m.alias ?? m.name) === aliasOrName)?.name
}

function waitMs(): number {
  const raw = Number(process.env.FANOUT_PROXY_WAIT_MS ?? '6000')
  return Number.isFinite(raw) && raw > 0 ? raw : 6000
}

// Synchronous TCP probe through the user's own bun binary: build() is sync,
// so this cannot await. One spawn covers the whole wait budget.
function tcpUp(port: number, budgetMs: number): boolean {
  const code =
    `const port=${port | 0},deadline=Date.now()+${budgetMs | 0};` +
    `for(;;){try{const s=await Bun.connect({hostname:'127.0.0.1',port,socket:{data(){},error(){}}});` +
    `try{s.end()}catch{ }process.exit(0)}catch(e){ }` +
    `if(Date.now()>=deadline)process.exit(1);await Bun.sleep(50)}`
  try {
    const p = Bun.spawnSync([process.execPath, '-e', code], {
      stdout: 'ignore',
      stderr: 'ignore',
      timeout: budgetMs + 3000
    })
    return p.exitCode === 0
  } catch {
    return false
  }
}

// True when the proxy answers on 127.0.0.1:<port>. When it is down, start
// ${CLIPROXY_BIN} detached with its output appended to <dir>/proxy.log and
// wait up to 6 s. Never throws and never reports the token.
export function ensureProxy(): boolean {
  let cfg: ProxyConfig
  try {
    cfg = readProxyConfig()
  } catch {
    return false
  }
  if (tcpUp(cfg.port, 300)) return true
  const bin = process.env.CLIPROXY_BIN ?? join(homeDir(), '.local', 'opt', 'cliproxyapi', 'cli-proxy-api')
  const dir = proxyDir()
  try {
    const log = openSync(join(dir, 'proxy.log'), 'a')
    try {
      const child = spawn(bin, ['-config', join(dir, 'config.yaml')], {
        detached: true,
        stdio: ['ignore', log, log]
      })
      child.unref()
    } finally {
      try {
        closeSync(log)
      } catch {
        // the wait below is the real signal; a log failure never blocks it
      }
    }
  } catch {
    // spawn failures surface as "down" below
  }
  return tcpUp(cfg.port, waitMs())
}

// The live model list for full preflight and discovery. Fail-open: any
// failure returns an empty list and the caller treats nothing as live.
export async function proxyModels(): Promise<ProxyModelInfo[]> {
  let cfg: ProxyConfig
  try {
    cfg = readProxyConfig()
  } catch {
    return []
  }
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.port}/v1/models`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(10000)
    })
    if (!res.ok) return []
    const body = (await res.json()) as { data?: unknown }
    if (!Array.isArray(body?.data)) return []
    return body.data.filter((m): m is ProxyModelInfo => typeof m === 'object' && m !== null)
  } catch {
    return []
  }
}

export function modelIds(models: ProxyModelInfo[]): string[] {
  const out: string[] = []
  for (const m of models) {
    for (const v of [m.id, m.name]) {
      if (typeof v === 'string' && v !== '' && !out.includes(v)) out.push(v)
    }
  }
  return out
}
