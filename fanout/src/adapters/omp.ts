import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Adapter, BuildInput, BuiltCommand, Classified, ModelInfo, Preflight, RunOutput, Usage } from './types'
import { SkipCandidate } from './types'
import { classify as classifyOut } from '../classify'
import type { Rule } from '../classify'
import { dataDir } from '../paths'
import { proxyDir } from './proxy'
import { loadCatalog } from '../catalog'

import ompJson from '../../patterns/omp.json'

// The worker gets its own OMP agent directory: only the built-in Anthropic
// provider, and none of the user's Claude Code plugins, MCP servers, global
// CLAUDE.md, skills or extensions. A project's own AGENTS.md and CLAUDE.md
// still load. The bundled catalog prices Fable 5.2 at Fable 5.1 rates, so the
// Anthropic pricing page values are set here.
const AGENT_CONFIG = `enabledProviders:
  - anthropic
disabledProviders: [claude, claude-plugins, omp-plugins, agent-plugins, mcp-json, vscode, cursor, windsurf, cline, codex, gemini, opencode, github, ssh-json]
`
const AGENT_MODELS = `providers:
  anthropic:
    modelOverrides:
      claude-fable-5-2:
        cost: { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 }
      claude-haiku-5-5:
        contextWindow: 1000000
`

const FAMILY = /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?$/

function versionOf(id: string): number {
  const m = FAMILY.exec(id)
  return m ? Number(m[2]) * 1000 + Number(m[3] ?? 0) : -1
}

/** The Console key CLIProxyAPI holds (first claude-api-key entry); one source for every client. */
export function anthropicKey(): string | undefined {
  try {
    const raw = Bun.YAML.parse(readFileSync(join(proxyDir(), 'config.yaml'), 'utf8')) as Record<string, unknown>
    const list = raw['claude-api-key']
    if (!Array.isArray(list)) return undefined
    for (const e of list) {
      const k = typeof e === 'object' && e !== null ? (e as Record<string, unknown>)['api-key'] : undefined
      if (typeof k === 'string' && k.startsWith('sk-ant-')) return k
    }
    return undefined
  } catch {
    return undefined
  }
}

export function ompAgentDir(): string {
  const dir = join(dataDir(), 'omp-agent')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'config.yml'), AGENT_CONFIG, { mode: 0o600 })
  writeFileSync(join(dir, 'models.yml'), AGENT_MODELS, { mode: 0o600 })
  return dir
}

function ompEnv(key: string): Record<string, string> {
  return { PI_CODING_AGENT_DIR: ompAgentDir(), ANTHROPIC_API_KEY: key, PI_NO_TITLE: '1' }
}

export class OmpAdapter implements Adapter {
  readonly name = 'omp'
  readonly envAllow: string[] = []
  readonly rules: Rule[] = (ompJson as { rules: Rule[] }).rules

  build(i: BuildInput): BuiltCommand {
    const key = anthropicKey()
    if (!key) throw new SkipCandidate('omp: no Anthropic key in the proxy config claude-api-key block')
    const argv = ['omp', '-p', '--mode', 'json', '--model', `anthropic/${i.model}`]
    if (i.effort) argv.push('--thinking', i.effort)
    argv.push(
      '--no-session',
      '--no-title',
      '--approval-mode',
      'yolo',
      '--no-skills',
      '--no-rules',
      '--no-extensions',
      '--no-lsp',
      '--cwd',
      i.cwd
    )
    // Stop a little before fanout's own timeout so OMP ends the turn cleanly.
    if (i.timeoutS > 60) argv.push('--max-time', String(i.timeoutS - 30))
    // A non-TTY stdin is read to EOF as the prompt.
    return { argv, cwd: i.cwd, env: ompEnv(key), stdinPath: i.briefPath, secrets: [key] }
  }

  classify(r: RunOutput, nowMs: number): Classified {
    return classifyOut(this, r, nowMs)
  }

  usage(stdout: string): Usage | undefined {
    let tokensIn = 0
    let tokensOut = 0
    let tokensCached = 0
    let costUsd = 0
    let seen = false
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('{')) continue
      let ev: { type?: unknown; message?: { role?: unknown; usage?: Record<string, unknown> } }
      try {
        ev = JSON.parse(line)
      } catch {
        continue
      }
      if (ev.type !== 'message_end' || ev.message?.role !== 'assistant') continue
      const u = ev.message.usage
      if (!u) continue
      const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
      seen = true
      tokensIn += num(u.input) + num(u.cacheWrite)
      tokensCached += num(u.cacheRead)
      tokensOut += num(u.output)
      costUsd += num((u.cost as Record<string, unknown> | undefined)?.total)
    }
    return seen ? { tokensIn, tokensOut, tokensCached, costUsd } : undefined
  }

  async listModels(): Promise<ModelInfo[]> {
    const key = anthropicKey()
    if (!key) return []
    const p = Bun.spawnSync(['omp', 'models', '--json'], {
      stdout: 'pipe',
      stderr: 'ignore',
      env: { ...process.env, ...ompEnv(key) }
    })
    if (p.exitCode !== 0) return []
    try {
      const parsed = JSON.parse(p.stdout.toString()) as { models?: Record<string, unknown>[] }
      // Anthropic keeps older snapshots live, so list only the newest of each
      // family plus any model the catalog already names.
      const known = new Set(
        loadCatalog()
          .rows.filter((r) => r.harness === 'omp')
          .map((r) => r.model)
      )
      const newest = new Map<string, string>()
      for (const m of parsed.models ?? []) {
        if (m.provider !== 'anthropic' || typeof m.id !== 'string') continue
        const fam = FAMILY.exec(m.id)
        if (!fam || Number(fam[2]) < 5) continue
        const prev = newest.get(fam[1])
        if (!prev || versionOf(m.id) > versionOf(prev)) newest.set(fam[1], m.id)
      }
      const keep = new Set([...newest.values(), ...known])
      const out: ModelInfo[] = []
      for (const m of parsed.models ?? []) {
        if (m.provider !== 'anthropic' || typeof m.id !== 'string' || !keep.has(m.id)) continue
        const cost = (m.cost ?? {}) as Record<string, unknown>
        const price = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
        out.push({
          model: m.id,
          billing: 'paid',
          priceIn: price(cost.input),
          priceCached: price(cost.cacheRead),
          priceOut: price(cost.output)
        })
      }
      return out
    } catch {
      return []
    }
  }

  async preflight(o?: { quick?: boolean }): Promise<Preflight> {
    if (!Bun.which('omp')) return { ok: false, outcome: 'model_unavailable', detail: 'omp not found on PATH' }
    const key = anthropicKey()
    if (!key)
      return { ok: false, outcome: 'auth_error', detail: 'no Anthropic key in the proxy config claude-api-key block' }
    if (o?.quick) return { ok: true }
    const p = Bun.spawnSync(['omp', 'models', '--json'], {
      stdout: 'ignore',
      stderr: 'ignore',
      env: { ...process.env, ...ompEnv(key) }
    })
    if (p.exitCode === 0) return { ok: true }
    return { ok: false, outcome: 'model_unavailable', detail: 'omp models did not exit 0' }
  }
}
