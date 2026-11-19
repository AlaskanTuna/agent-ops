import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { nowMs } from './clock'
import { dataDir } from './paths'
import type { Adapter } from './adapters/types'
import { loadCatalog, type CatalogRow, type DataClass } from './catalog'

export type ChunkClass = 'public' | 'private'

interface CacheEntry {
  public: boolean
  ts: string
}

function cachePath(): string {
  return `${dataDir()}/run/dataclass-cache.json`
}

function readCache(): Record<string, CacheEntry> {
  try {
    if (!existsSync(cachePath())) return {}
    return JSON.parse(readFileSync(cachePath(), 'utf8')) as Record<string, CacheEntry>
  } catch {
    return {}
  }
}

function writeCache(cache: Record<string, CacheEntry>): void {
  try {
    mkdirSync(`${dataDir()}/run`, { recursive: true, mode: 0o700 })
    writeFileSync(cachePath(), JSON.stringify(cache), { mode: 0o600 })
  } catch {
    // cache failures never block a run
  }
}

function remoteUrls(dir: string): string[] | undefined {
  const run = (args: string[]): string | undefined => {
    const p = Bun.spawnSync(['git', '-C', dir, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' },
      stdout: 'pipe',
      stderr: 'ignore'
    })
    if (p.exitCode !== 0) return undefined
    return p.stdout.toString()
  }
  const names = run(['remote'])
  if (names === undefined) return undefined
  const urls: string[] = []
  for (const name of names
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const out = run(['remote', 'get-url', '--all', name])
    if (out === undefined) return undefined
    for (const u of out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean))
      urls.push(u)
  }
  return [...new Set(urls)]
}

export function toAnonymousHttps(url: string): string | undefined {
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(url)
  if (scp) return `https://${scp[1]}/${scp[2]}`
  const m = /^(?:ssh|git\+ssh|https?|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(url)
  if (m) return `https://${m[1]}/${m[2]}`
  return undefined
}

function probeUrl(url: string): boolean | undefined {
  // Anonymous probe: no credential helper, no user/system git config, no SSH agent. A probe that used the
  // user's login would read their own private repos as public. SSH URLs are rewritten to anonymous HTTPS.
  const anon = toAnonymousHttps(url)
  if (anon === undefined) return false
  const p = Bun.spawnSync(['git', '-c', 'credential.helper=', 'ls-remote', '--exit-code', anon, 'HEAD'], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '/',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'true',
      SSH_ASKPASS: 'true',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1'
    },
    stdout: 'ignore',
    stderr: 'ignore',
    timeout: 5000
  })
  if (p.exitCode === 0) return true
  if (p.exitCode === 2 || (p.signalCode as string | null) === 'SIGTERM') return undefined
  return false
}

function probeRemotes(dir: string): ChunkClass {
  const urls = remoteUrls(dir)
  if (urls === undefined || urls.length === 0) return 'private'
  const cache = readCache()
  let dirty = false
  const now = nowMs()
  for (const url of urls) {
    const entry = cache[url]
    if (entry) {
      const age = now - Date.parse(entry.ts)
      if (!Number.isNaN(age) && age >= 0 && age < 24 * 3600 * 1000) {
        if (!entry.public) return 'private'
        continue
      }
    }
    const ok = probeUrl(url)
    if (ok === true) {
      cache[url] = { public: true, ts: new Date(now).toISOString() }
      dirty = true
      continue
    }
    if (ok === false) {
      cache[url] = { public: false, ts: new Date(now).toISOString() }
      dirty = true
    }
    // A failed or uncertain probe is private for this run (fail closed).
    if (dirty) writeCache(cache)
    return 'private'
  }
  if (dirty) writeCache(cache)
  return 'public'
}

export function chunkClass(dir: string, flags?: { public?: boolean; private?: boolean }): ChunkClass {
  if (flags?.public) return 'public'
  if (flags?.private) return 'private'
  const probe = process.env.FANOUT_PROBE
  if (probe === 'public' || probe === 'private') return probe
  return probeRemotes(dir)
}

export function upstreamClass(upstream: string | undefined): DataClass {
  if (!upstream) return 'any'
  if (upstream.includes('contributor') || upstream.startsWith('stealth/') || upstream.endsWith(':free')) {
    return 'public-only'
  }
  return 'any'
}

export function rowClass(row: CatalogRow, adapter: Adapter): DataClass {
  if (row.dataClass === 'public-only') return 'public-only'
  const upstream = adapter.upstream?.(row.model)
  if (row.harness === 'openrouter-fanout') {
    // The proxy hides the vendor behind the alias: an upstream that is not
    // the upstream cell of an any catalog row (a config edit pointing at an
    // unreviewed model, an unknown OpenRouter row, an unreadable config) is
    // public-only, even when the catalog cell says any. An alias missing from
    // the openrouter block has no upstream at all; build() refuses it with a
    // NOTE before anything starts, so it stays routable here.
    if (upstream !== undefined && !isKnownAnyUpstream(upstream)) return 'public-only'
  }
  if (upstreamClass(upstream) === 'public-only') return 'public-only'
  return 'any'
}

// True when some any catalog row carries this upstream cell. Used by the
// openrouter-fanout adapter to decide whether a configured upstream is reviewed.
export function isKnownAnyUpstream(upstream: string): boolean {
  try {
    return loadCatalog().rows.some((r) => r.dataClass === 'any' && r.upstream === upstream)
  } catch {
    return false
  }
}
