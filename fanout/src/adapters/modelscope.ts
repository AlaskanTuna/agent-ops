import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { BuildInput, BuiltCommand, Classified, ModelInfo, Preflight, RunOutput, Usage } from './types'
import { SkipCandidate } from './types'
import { ClaudeCliAdapter, type ClaudeCliConfig } from './claude-cli'
import { proxyDir } from './proxy'
import { homeDir } from '../paths'
import { loadCatalog } from '../catalog'
import type { Rule } from '../classify'

import modelscopeJson from '../../patterns/modelscope.json'

export { proxyDir } from './proxy'

const MODELSCOPE_BASE_URL = 'https://api-inference.modelscope.ai/v1'

function modelscopeRules(): Rule[] {
  try {
    const rules = (modelscopeJson as { rules: Rule[] }).rules
    return Array.isArray(rules) ? rules : []
  } catch {
    return []
  }
}

const modelscopeConfig: ClaudeCliConfig = {
  name: 'modelscope',
  baseUrl: () => `http://127.0.0.1:${readModelScopeConfig().port}`,
  token: () => {
    try {
      return readModelScopeConfig().token
    } catch {
      return undefined
    }
  },
  missingKeyNote: 'proxy config unreadable; check FANOUT_PROXY_DIR or ~/.cli-proxy-api/config.yaml',
  defaults: { timeoutS: 600, maxTurns: 8 },
  billing: 'per_call'
}

interface ModelScopeEntry {
  name: string
  alias?: string
}

interface ModelScopeConfig {
  port: number
  token: string
  models: ModelScopeEntry[]
}

function invalid(): Error {
  return new Error('invalid ModelScope routing config')
}

// The ModelScope routing config keeps one api key per provider, so the shared
// proxy reader (top-level api-keys) cannot parse it. Every failure reports a
// fixed string: the config content is never echoed.
export function readModelScopeConfig(): ModelScopeConfig {
  let raw: unknown
  try {
    raw = Bun.YAML.parse(readFileSync(join(proxyDir(), 'config.yaml'), 'utf8'))
  } catch {
    throw invalid()
  }
  if (typeof raw !== 'object' || raw === null) throw invalid()
  const o = raw as Record<string, unknown>
  const port = o.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw invalid()
  if (!Array.isArray(o.providers)) throw invalid()
  const scoped = o.providers.filter(
    (p) => typeof p === 'object' && p !== null && (p as Record<string, unknown>).name === 'modelscope'
  )
  if (scoped.length !== 1) throw invalid()
  const ms = scoped[0] as Record<string, unknown>
  if (ms.baseUrl !== MODELSCOPE_BASE_URL) throw invalid()
  const keys = ms['api-keys']
  if (!Array.isArray(keys) || typeof keys[0] !== 'string' || keys[0] === '') throw invalid()
  if (!Array.isArray(ms.models)) throw invalid()
  const models: ModelScopeEntry[] = []
  for (const m of ms.models) {
    if (typeof m !== 'object' || m === null) throw invalid()
    const entry = m as Record<string, unknown>
    if (typeof entry.name !== 'string' || entry.name === '') throw invalid()
    if (entry.alias !== undefined && (typeof entry.alias !== 'string' || entry.alias === '')) throw invalid()
    models.push(entry.alias === undefined ? { name: entry.name } : { name: entry.name, alias: entry.alias as string })
  }
  const aliases = models.map((m) => m.alias).filter((a): a is string => a !== undefined)
  if (new Set(aliases).size !== aliases.length) throw invalid()
  // No ModelScope name or alias may collide with another provider's names or aliases.
  const foreign = new Set<string>()
  for (const p of o.providers) {
    if (typeof p !== 'object' || p === null) continue
    const po = p as Record<string, unknown>
    if (po.name === 'modelscope') continue
    if (typeof po.name === 'string' && po.name !== '') foreign.add(po.name)
    if (!Array.isArray(po.models)) continue
    for (const m of po.models) {
      if (typeof m !== 'object' || m === null) continue
      const mo = m as Record<string, unknown>
      if (typeof mo.name === 'string' && mo.name !== '') foreign.add(mo.name)
      if (typeof mo.alias === 'string' && mo.alias !== '') foreign.add(mo.alias)
    }
  }
  for (const m of models) {
    if (foreign.has(m.name)) throw invalid()
    if (m.alias !== undefined && foreign.has(m.alias)) throw invalid()
  }
  return { port, token: keys[0] as string, models }
}

function collectLive(data: unknown): Set<string> | undefined {
  if (!Array.isArray(data)) return undefined
  const live = new Set<string>()
  for (const m of data) {
    if (typeof m !== 'object' || m === null) continue
    const entry = m as Record<string, unknown>
    if (entry.owned_by !== 'modelscope') continue
    for (const v of [entry.id, entry.name]) {
      if (typeof v === 'string' && v !== '') live.add(v)
    }
  }
  return live
}

async function fetchLiveIds(port: number, token: string): Promise<Set<string> | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000)
    })
    if (!res.ok) return undefined
    const body = (await res.json()) as { data?: unknown }
    return collectLive(body?.data)
  } catch {
    return undefined
  }
}

// build() is sync, so liveness is checked through a spawned bun one-liner. The
// token travels in the child's environment, never on its command line.
function liveIdsSync(cfg: ModelScopeConfig): Set<string> | undefined {
  const script = [
    'const port = Number(process.env.FANOUT_MS_PORT ?? "")',
    'const token = process.env.FANOUT_MS_TOKEN ?? ""',
    'try {',
    '  const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {',
    '    headers: token === "" ? {} : { Authorization: `Bearer ${token}` },',
    '    signal: AbortSignal.timeout(8000)',
    '  })',
    '  if (!res.ok) process.exit(1)',
    '  const body = await res.json()',
    '  console.log(JSON.stringify(Array.isArray(body?.data) ? body.data : []))',
    '} catch { process.exit(1) }'
  ].join('\n')
  try {
    const p = Bun.spawnSync([process.execPath, '-e', script], {
      stdout: 'pipe',
      stderr: 'ignore',
      env: { ...process.env, FANOUT_MS_PORT: String(cfg.port), FANOUT_MS_TOKEN: cfg.token },
      timeout: 15000
    })
    if (p.exitCode !== 0) return undefined
    return collectLive(JSON.parse(p.stdout.toString()))
  } catch {
    return undefined
  }
}

function proxyWaitMs(): number {
  const raw = Number(process.env.FANOUT_PROXY_WAIT_MS ?? '6000')
  return Number.isFinite(raw) && raw > 0 ? raw : 6000
}

// Synchronous TCP probe, as in the shared proxy helper: build() is sync, so
// this cannot await. One spawn covers the whole wait budget.
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
// wait up to 6 s. Never throws and never reports the token. The shared helper
// cannot be used: it reads the shared config format, not the per-provider
// keys of the ModelScope routing config.
function ensureModelScopeProxy(cfg: ModelScopeConfig): boolean {
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
  return tcpUp(cfg.port, proxyWaitMs())
}

function resolveRoute(cfg: ModelScopeConfig, live: Set<string> | undefined, model: string): string {
  const configured = cfg.models.some((m) => (m.alias ?? m.name) === model)
  // The model itself when it is a live route.
  if (live === undefined ? configured : configured && live.has(model)) return model
  // Else the first alias (sorted) whose upstream name matches.
  const aliases = cfg.models
    .filter((m) => m.name === model && m.alias !== undefined)
    .map((m) => m.alias as string)
    .sort()
  if (aliases.length > 0) return aliases[0]
  // Never a hidden fallback to another provider.
  throw new SkipCandidate('not a live ModelScope route')
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
      return undefined
    } catch {
      // not JSON; keep scanning older lines
    }
  }
  return undefined
}

function catalogPriceCall(model: string): number | undefined {
  try {
    const row = loadCatalog().rows.find((r) => r.harness === 'modelscope' && r.model === model)
    return typeof row?.priceCall === 'number' ? row.priceCall : undefined
  } catch {
    return undefined
  }
}

export class ModelScopeAdapter extends ClaudeCliAdapter {
  readonly proxyBacked = true

  constructor() {
    super(modelscopeConfig, modelscopeRules())
  }

  override build(i: BuildInput): BuiltCommand {
    let cfg: ModelScopeConfig
    try {
      cfg = readModelScopeConfig()
    } catch {
      throw new SkipCandidate('invalid ModelScope routing config', 'auth_error')
    }
    if (!ensureModelScopeProxy(cfg)) throw new SkipCandidate('modelscope: proxy not reachable')
    const route = resolveRoute(cfg, liveIdsSync(cfg), i.model)
    const briefText = readFileSync(i.briefPath, 'utf8')
    // An empty dir: no plugins or hooks ride along. The mode keeps the
    // endpoint override and the token out of other users' reach.
    const home = process.env.HOME ?? process.env.FANOUT_HOME ?? '/tmp'
    const configDir = join(home, '.modelscope-fanout')
    try {
      mkdirSync(configDir, { recursive: true, mode: 0o700 })
      chmodSync(configDir, 0o700)
    } catch {
      // a missing dir never blocks a run; the worker falls back to its default
    }
    return {
      argv: [
        'claude',
        '-p',
        '--model',
        route,
        '--setting-sources',
        '',
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--settings',
        '{"disableAllHooks":true}',
        '--tools',
        'Read,Edit,Write,Glob,Grep',
        '--permission-mode',
        'acceptEdits',
        '--max-turns',
        String(i.maxTurns),
        '--output-format',
        'json',
        '--no-session-persistence'
      ],
      cwd: i.cwd,
      env: {
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${cfg.port}`,
        ANTHROPIC_AUTH_TOKEN: cfg.token,
        ANTHROPIC_API_KEY: null,
        ANTHROPIC_MODEL: route,
        ANTHROPIC_DEFAULT_OPUS_MODEL: route,
        ANTHROPIC_DEFAULT_SONNET_MODEL: route,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: route,
        CLAUDE_CODE_SUBAGENT_MODEL: route,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
      },
      // --bypass and --allow are ignored: the parent runs commands and tests.
      stdinText: `Your working directory is ${i.cwd}. Resolve all relative output paths inside that directory. Never guess a home-directory path.\n\n${briefText}`,
      secrets: [cfg.token]
    }
  }

  override classify(r: RunOutput, nowMs: number): Classified {
    const line = lastJsonLine(r.stdout)
    if (line?.type === 'result' && line?.subtype === 'success' && line?.is_error !== true) {
      return { outcome: 'ok' }
    }
    const base = super.classify(r, nowMs)
    // A clean exit without a success result means the worker died before reporting.
    if (base.outcome === 'ok') return { outcome: 'worker_error' }
    return base
  }

  override usage(_stdout: string): Usage | undefined {
    void _stdout
    // Magicubes bill per upstream call, not per token.
    return undefined
  }

  upstream(model: string): string | undefined {
    // The route's upstream name comes from the routing config. Without a
    // readable config (or for a model the config does not name) fall back to
    // the catalog: a modelscope row's model is its upstream name. The run
    // still refuses to start without a valid config, so this hint never sends
    // a private chunk anywhere unverified.
    let cfg: ModelScopeConfig | undefined
    try {
      cfg = readModelScopeConfig()
    } catch {
      cfg = undefined
    }
    if (cfg !== undefined) {
      const hit = cfg.models.find((m) => (m.alias ?? m.name) === model)
      if (hit !== undefined) return hit.name
    }
    try {
      const row = loadCatalog().rows.find((r) => r.harness === 'modelscope' && r.model === model)
      if (row !== undefined) return row.model
    } catch {
      // an unreadable catalog leaves the model unknown
    }
    return undefined
  }

  override async listModels(): Promise<ModelInfo[]> {
    let cfg: ModelScopeConfig
    try {
      cfg = readModelScopeConfig()
    } catch {
      return []
    }
    const live = await fetchLiveIds(cfg.port, cfg.token)
    if (live === undefined) return []
    return [...new Set(cfg.models.filter((m) => live.has(m.alias ?? m.name)).map((m) => m.name))]
      .sort()
      .map((model) => ({
        model,
        efforts: [],
        billing: 'per_call' as const,
        priceCall: catalogPriceCall(model) ?? 2,
        dataClass: 'any' as const
      }))
  }

  override async preflight(o?: { quick?: boolean }): Promise<Preflight> {
    if (!Bun.which('claude')) return { ok: false, outcome: 'model_unavailable', detail: 'claude not found on PATH' }
    let cfg: ModelScopeConfig
    try {
      cfg = readModelScopeConfig()
    } catch {
      return { ok: false, outcome: 'auth_error', detail: 'invalid ModelScope routing config' }
    }
    if (o?.quick) return { ok: true }
    if (!ensureModelScopeProxy(cfg))
      return { ok: false, outcome: 'model_unavailable', detail: 'modelscope: proxy not reachable' }
    const live = await fetchLiveIds(cfg.port, cfg.token)
    if (live === undefined || ![...live].some((id) => cfg.models.some((m) => (m.alias ?? m.name) === id))) {
      return {
        ok: false,
        outcome: 'model_unavailable',
        detail: 'modelscope: no ModelScope route is listed by the proxy'
      }
    }
    return { ok: true }
  }

  async measure(w: {
    startMs: number
    endMs: number
    route: string
    overlapped: boolean
  }): Promise<{ calls: number } | 'unmeasured'> {
    void w.route
    if (w.overlapped) return 'unmeasured'
    const log = join(proxyDir(), 'proxy.log')
    let mtime: number
    try {
      mtime = statSync(log).mtimeMs
    } catch {
      return 'unmeasured'
    }
    // A log older than the job end cannot hold the job's calls.
    if (mtime < w.endMs) return 'unmeasured'
    let text: string
    try {
      text = readFileSync(log, 'utf8')
    } catch {
      return 'unmeasured'
    }
    const lines = text.split('\n')
    // The log has no model field, so attribution works only through gin lines;
    // without them there is nothing to count.
    if (!lines.some((l) => /\[gin_logger\.go:\d+\]/.test(l))) return 'unmeasured'
    const re = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\][^\n]*POST "\/v1\/messages"/
    let calls = 0
    for (const line of lines) {
      const m = re.exec(line)
      if (!m) continue
      const t = new Date(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
        Number(m[6])
      ).getTime()
      if (Number.isNaN(t)) continue
      if (t >= w.startMs && t <= w.endMs + 2000) calls += 1
    }
    return { calls }
  }
}
