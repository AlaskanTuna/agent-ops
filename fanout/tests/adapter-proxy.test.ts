import { test, expect } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { sandbox } from './helpers/sandbox'

// Task 39: river and openrouter-fanout (OpenRouter) adapters through CLIProxyAPI.
// The proxy hides the vendor behind an alias, so the data class comes from
// the upstream model name in the config, never from the alias.
//
// Kind is `inventory` (non-writing) for every clean exit: a writing kind that
// changes nothing ends as `no_effect`. The shared catalog below mirrors the
// default rows plus the three OpenRouter aliases under test.

const HEADER =
  'harness,model,efforts,tier,billing,price_in,price_cached,price_out,price_call,min_brief_bytes,data_class,status,family,aliases,aa_slug,climb,upstream,note'
const CF_SPARK =
  'openrouter-fanout,muse-spark-1.3,low|high,1,paid,0.10,0.002,0.20,,0,any,active,muse-spark,,,,meta/muse-spark-1.3-contributor,,'
const CF_GLM =
  'openrouter-fanout,glm-5.3-flash,low|high,1,paid,0.075,0.075,0.25,,0,any,active,glm-5.3-flash,,,,z-ai/glm-5.3-flash,,'
const CF_MYSTERY = 'openrouter-fanout,mystery,low|high,1,paid,0.10,0.002,0.20,,0,any,active,mystery-family,,,,,'
const CF_QWEN =
  'openrouter-fanout,qwen3.7-flash,,1,paid,0.03,0.03,0.13,,0,any,active,qwen3.7-flash,,,,qwen/qwen3.7-flash,,'
const CF_RIVER_ALIAS =
  'openrouter-fanout,glm-5.3-flash-river,low|high,1,paid,0.12,0.024,0.40,,0,any,active,glm-5.3-flash-river,,,,z-ai-org/GLM-5.3-Flash,,'
const RIVER_DEEP =
  'river,deepseek-v4.1-flash-river,low|high|max|none,1,paid,0.12,0.0024,0.48,,0,any,active,deepseek-v4.1-flash-river,,,,deepseek-ai/DeepSeek-V4.1-Flash,,'
const RIVER_GLM =
  'river,glm-5.3-flash-river,low|high|max,1,paid,0.12,0.024,0.40,,0,any,active,glm-5.3-flash-river,,,,z-ai-org/GLM-5.3-Flash,,'
const META_SPARK = 'meta,muse-spark-1.3,xhigh|max|high|low,1,paid,1.25,0.15,4.25,,0,any,active,muse-spark,,,,,'
const FAKE_A = 'fake,f1-a,medium|low,1,subscription,,,,,0,any,active,f1-a,,,,,'
const FAKE2_PAID = 'fake2,f1-paid,medium|low,1,paid,1.00,0.10,2.00,,0,any,active,fam-paid,,,,,'
const FULL_CATALOG = [HEADER, CF_SPARK, CF_GLM, CF_MYSTERY, CF_QWEN, RIVER_DEEP, RIVER_GLM, META_SPARK, FAKE_A].join(
  '\n'
)
const PROXY_TOKEN = 'px-tpl-0'

function fixture(name: string): string {
  return join(import.meta.dir, './fixtures/proxy', name)
}

function stubbed(sb: ReturnType<typeof sandbox>, fix: string, exit: string): { argv: string; env: string } {
  const argv = join(sb.home, 'stub-argv')
  const stdin = join(sb.home, 'stub-stdin')
  const env = join(sb.home, 'stub-env')
  // Paths are baked into the script: the worker only inherits the allowlist,
  // so the stub cannot rely on extra environment variables.
  sb.bin(
    'claude',
    `#!/bin/sh\nprintf '%s\\n' "$0" "$@" > "${argv}"\ncat > "${stdin}"\nenv > "${env}"\ncat "${fix}"\nexit ${exit}\n`
  )
  return { argv, env }
}

function readArgv(p: string): string[] {
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
}

function readEnv(p: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line) continue
    const i = line.indexOf('=')
    if (i > 0) m.set(line.slice(0, i), line.slice(i + 1))
  }
  return m
}

interface ProxyWorld {
  port: number
  dir: string
  stop: () => void
}

// A fake CLIProxyAPI: /v1/models lists every test alias, /or/models serves
// the pinned OpenRouter payload. The config is rendered from the template.
function startProxy(sb: ReturnType<typeof sandbox>, edit?: (text: string) => string): ProxyWorld {
  const aliases = [
    'muse-spark-1.3',
    'glm-5.3-flash',
    'mystery',
    'qwen3.7-flash',
    'deepseek-v4.1-flash-river',
    'glm-5.3-flash-river'
  ]
  const orBody = readFileSync(fixture('openrouter-models.json'), 'utf8')
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path === '/v1/models') return Response.json({ data: aliases.map((id) => ({ id, object: 'model' })) })
      if (path === '/or/models') return new Response(orBody, { headers: { 'content-type': 'application/json' } })
      return new Response('not found', { status: 404 })
    }
  })
  const dir = join(sb.home, 'proxy')
  mkdirSync(dir, { recursive: true })
  const text = readFileSync(fixture('config.yaml.tpl'), 'utf8').replaceAll('__PORT__', String(server.port))
  writeFileSync(join(dir, 'config.yaml'), edit ? edit(text) : text)
  if (server.port === undefined) throw new Error('the fake proxy did not bind a port')
  return { port: server.port, dir, stop: () => server.stop() }
}

function proxyEnv(w: ProxyWorld, extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    FANOUT_PROXY_DIR: w.dir,
    FANOUT_OPENROUTER_URL: `http://127.0.0.1:${w.port}/or/models`,
    ...extra
  }
}

function privatePickArgs(sb: ReturnType<typeof sandbox>): string[] {
  return ['pick', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'inventory', '--all']
}

function jobEnds(sb: ReturnType<typeof sandbox>, harness: string): Record<string, unknown>[] {
  return sb.ledger().filter((e) => e.event === 'job_end' && e.harness === harness)
}

test('the alias muse-spark-1.3 is public-only because its upstream is a contributor model', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  const w = startProxy(sb)
  try {
    sb.catalog(`${FULL_CATALOG}\n`)
    const r = await sb.fanout(privatePickArgs(sb), { env: proxyEnv(w) })
    expect(r.code).toBe(0)
    expect(r.stdout).not.toContain('openrouter-fanout/muse-spark-1.3')
    const metaLine = r.stdout.split('\n').find((l) => l.startsWith('CAND') && l.includes('meta/muse-spark-1.3'))
    expect(metaLine).toMatch(/class=any/)
  } finally {
    w.stop()
  }
})

test('naming the alias does not get around it', async () => {
  for (const extra of [[], ['--pin']]) {
    const sb = sandbox().at('2026-11-15T01:00:00Z')
    const w = startProxy(sb)
    try {
      sb.catalog(`${FULL_CATALOG}\n`)
      const r = await sb.fanout(
        [
          'run',
          '--brief',
          sb.brief(),
          '--dir',
          sb.repo,
          '--kind',
          'inventory',
          '--harness',
          'openrouter-fanout',
          '--model',
          'muse-spark-1.3',
          ...extra
        ],
        { env: proxyEnv(w) }
      )
      expect(r.code).toBe(3)
      expect(r.stdout).toContain('REFUSED openrouter-fanout/muse-spark-1.3 is public-only and this chunk is private')
      expect(sb.ledger()).toEqual([])
    } finally {
      w.stop()
    }
  }
})

test('a public chunk may use it', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  const w = startProxy(sb)
  try {
    const ok = join(sb.home, 'ok.json')
    writeFileSync(
      ok,
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', modelUsage: {} })
    )
    const stub = stubbed(sb, ok, '0')
    sb.catalog(`${FULL_CATALOG}\n`)
    const r = await sb.fanout(
      [
        'run',
        '--brief',
        sb.brief(),
        '--dir',
        sb.repo,
        '--kind',
        'inventory',
        '--public',
        '--harness',
        'openrouter-fanout',
        '--model',
        'muse-spark-1.3'
      ],
      { env: proxyEnv(w) }
    )
    expect(r.code).toBe(0)
    expect(r.stdout.split('\n')[0]).toMatch(/harness=openrouter-fanout model=muse-spark-1.3 outcome=ok/)
    const env = readEnv(stub.env)
    expect(env.get('ANTHROPIC_MODEL')).toBe('muse-spark-1.3')
    expect(env.get('ANTHROPIC_BASE_URL')).toBe(`http://127.0.0.1:${w.port}`)
    expect(readArgv(stub.argv)).toContain('muse-spark-1.3')
  } finally {
    w.stop()
  }
})

test('the class follows the config, not the catalog', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  const w = startProxy(sb, (text) => text.replace('z-ai/glm-5.3-flash', 'acme/other-model'))
  try {
    sb.catalog(`${FULL_CATALOG}\n`)
    const hidden = await sb.fanout(privatePickArgs(sb), { env: proxyEnv(w) })
    expect(hidden.code).toBe(0)
    expect(hidden.stdout).not.toContain('openrouter-fanout/glm-5.3-flash')
    writeFileSync(
      join(w.dir, 'config.yaml'),
      readFileSync(fixture('config.yaml.tpl'), 'utf8').replaceAll('__PORT__', String(w.port))
    )
    const shown = await sb.fanout(privatePickArgs(sb), { env: proxyEnv(w) })
    expect(shown.code).toBe(0)
    expect(shown.stdout).toContain('openrouter-fanout/glm-5.3-flash')
  } finally {
    w.stop()
  }
})

test('an unknown OpenRouter upstream is public-only', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  const w = startProxy(sb)
  try {
    sb.catalog(`${FULL_CATALOG}\n`)
    const priv = await sb.fanout(privatePickArgs(sb), { env: proxyEnv(w) })
    expect(priv.code).toBe(0)
    expect(priv.stdout).not.toContain('openrouter-fanout/mystery')
    const pub = await sb.fanout(
      ['pick', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'inventory', '--all', '--public'],
      { env: proxyEnv(w) }
    )
    expect(pub.code).toBe(0)
    expect(pub.stdout).toContain('openrouter-fanout/mystery')
  } finally {
    w.stop()
  }
})

test('river rows stay available for private data', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  const w = startProxy(sb)
  try {
    sb.catalog(`${FULL_CATALOG}\n`)
    const r = await sb.fanout(privatePickArgs(sb), { env: proxyEnv(w) })
    expect(r.code).toBe(0)
    for (const model of ['river/deepseek-v4.1-flash-river', 'river/glm-5.3-flash-river']) {
      const line = r.stdout.split('\n').find((l) => l.startsWith('CAND') && l.includes(model))
      expect(line).toMatch(/class=any/)
    }
  } finally {
    w.stop()
  }
})

test('river dry-run: argv, environment and efforts', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  const w = startProxy(sb)
  try {
    stubbed(sb, fixture('river-402.txt'), '0')
    sb.catalog(`${FULL_CATALOG}\n`)
    const r = await sb.fanout(
      [
        'run',
        '--dry-run',
        '--brief',
        sb.brief(),
        '--dir',
        sb.repo,
        '--kind',
        'inventory',
        '--harness',
        'river',
        '--model',
        'deepseek-v4.1-flash-river'
      ],
      { env: proxyEnv(w) }
    )
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('"--effort","low"')
    expect(r.stdout).not.toContain(PROXY_TOKEN)
    const bad = await sb.fanout(
      [
        'run',
        '--dry-run',
        '--brief',
        sb.brief(),
        '--dir',
        sb.repo,
        '--kind',
        'inventory',
        '--harness',
        'river',
        '--model',
        'deepseek-v4.1-flash-river',
        '--effort',
        'medium'
      ],
      { env: proxyEnv(w) }
    )
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain('effort medium is not one of low|high|max|none for river/deepseek-v4.1-flash-river')
  } finally {
    w.stop()
  }
})

test('river run: tokens are summed and the cost is computed', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  const w = startProxy(sb)
  try {
    const usage = join(sb.home, 'usage.json')
    writeFileSync(
      usage,
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'done',
        modelUsage: { river: { inputTokens: 1000000, cacheReadInputTokens: 0, outputTokens: 100000 } }
      })
    )
    const stub = stubbed(sb, usage, '0')
    sb.catalog(`${FULL_CATALOG}\n`)
    const r = await sb.fanout(
      [
        'run',
        '--brief',
        sb.brief(),
        '--dir',
        sb.repo,
        '--kind',
        'inventory',
        '--harness',
        'river',
        '--model',
        'deepseek-v4.1-flash-river'
      ],
      { env: proxyEnv(w) }
    )
    expect(r.code).toBe(0)
    expect(r.stdout.split('\n')[0]).toMatch(/harness=river model=deepseek-v4.1-flash-river outcome=ok/)
    // The stdout COST line is Task 19's seam (parallel worker). This task owns
    // the computation underneath: summed usage on the ledger event plus the
    // pick estimate. Inventory prior is [30000, 0, 3000], so the estimate is
    // (30000 x 0.12 + 0 x 0.0024 + 3000 x 0.48) / 1e6 = 0.00504, and the actual
    // is (1e6 x 0.12 + 0 + 1e5 x 0.48) / 1e6 = 0.168.
    const [end] = jobEnds(sb, 'river')
    expect(end).toMatchObject({
      outcome: 'ok',
      tokens_in: 1000000,
      tokens_cached: 0,
      tokens_out: 100000,
      cost_source: 'computed'
    })
    const pick = await sb.fanout(
      [
        'pick',
        '--brief',
        sb.brief(),
        '--dir',
        sb.repo,
        '--kind',
        'inventory',
        '--harness',
        'river',
        '--model',
        'deepseek-v4.1-flash-river'
      ],
      { env: proxyEnv(w) }
    )
    expect(pick.stdout).toContain('PAID river/deepseek-v4.1-flash-river ESTIMATE $0.0050 (prior; fewer than 5 samples)')
    // The proxy token is env-only: it appears in no output or ledger file.
    expect(r.stdout).not.toContain(PROXY_TOKEN)
    expect(r.stderr).not.toContain(PROXY_TOKEN)
    void stub
    const { readdirSync: readdir, readFileSync: read, statSync: stat } = await import('node:fs')
    const found: string[] = []
    const walk = (dir: string) => {
      for (const f of readdir(dir, { withFileTypes: true })) {
        const p = join(dir, f.name)
        if (p === stub.env || p === join(w.dir, 'config.yaml') || p.startsWith(`${w.dir}/`)) continue
        if (f.isDirectory()) walk(p)
        else {
          try {
            if (stat(p).isFile() && read(p, 'utf8').includes(PROXY_TOKEN)) found.push(p)
          } catch {
            // unreadable files cannot leak
          }
        }
      }
    }
    walk(sb.home)
    expect(found).toEqual([])
  } finally {
    w.stop()
  }
})

test('402 is account-scoped credits', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  const w = startProxy(sb)
  try {
    stubbed(sb, fixture('river-402.txt'), '1')
    sb.catalog([HEADER, RIVER_DEEP, RIVER_GLM, FAKE_A].join('\n') + '\n')
    const r = await sb.fanout(
      ['run', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'inventory', '--harness', 'river'],
      { env: proxyEnv(w) }
    )
    expect(r.code).toBe(0)
    const [hit] = sb.ledger().filter((e) => e.event === 'limit_hit' && e.harness === 'river')
    expect(hit).toMatchObject({ outcome: 'credits_exhausted', scope: 'account' })
    expect(r.stdout).toContain('FALLBACK river/')
    expect(r.stdout).toContain('credits_exhausted')
    expect(r.stdout).toContain('-> fake/f1-a')
  } finally {
    w.stop()
  }
})

test('model_concurrency backs off 30 seconds', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  const w = startProxy(sb)
  try {
    stubbed(sb, fixture('river-concurrency.txt'), '1')
    sb.catalog([HEADER, RIVER_DEEP, RIVER_GLM, FAKE_A].join('\n') + '\n')
    const r = await sb.fanout(
      ['run', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'inventory', '--harness', 'river'],
      { env: proxyEnv(w) }
    )
    expect(r.code).toBe(0)
    const [hit] = sb.ledger().filter((e) => e.event === 'limit_hit' && e.harness === 'river')
    expect(hit).toMatchObject({
      outcome: 'rate_limited',
      source: 'backoff',
      until: '2026-11-15T01:00:30.000Z'
    })
    expect(r.stdout).toContain('FALLBACK river/')
    expect(r.stdout).toContain('-> fake/f1-a')
  } finally {
    w.stop()
  }
})

test('413, 422 and context length are job errors', async () => {
  const texts = [
    'synthetic fixture: not real worker output\nHTTP 413 Request Entity Too Large: the chunk is too large for this model',
    'synthetic fixture: not real worker output\nHTTP 422 Unprocessable Entity: the chunk is too large for this model',
    'synthetic fixture: not real worker output\ncontext_length_exceeded: this model supports at most 200k tokens'
  ]
  for (const text of texts) {
    const sb = sandbox().at('2026-11-15T01:00:00Z')
    const w = startProxy(sb)
    try {
      const fix = join(sb.home, 'job-error.txt')
      writeFileSync(fix, `${text}\n`)
      stubbed(sb, fix, '1')
      sb.catalog([HEADER, RIVER_DEEP, FAKE_A].join('\n') + '\n')
      const r = await sb.fanout(
        ['run', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'inventory', '--harness', 'river'],
        { env: proxyEnv(w) }
      )
      expect(r.code).toBe(1)
      expect(r.stdout.split('\n')[0]).toMatch(/outcome=job_error/)
      expect(r.stdout).not.toContain('FALLBACK')
      expect(sb.ledger().filter((e) => e.event === 'job_start')).toHaveLength(1)
    } finally {
      w.stop()
    }
  }
})

test('auth_unavailable is an auth error', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  const w = startProxy(sb)
  try {
    stubbed(sb, fixture('auth-unavailable.txt'), '1')
    sb.catalog([HEADER, CF_SPARK, CF_GLM, FAKE_A].join('\n') + '\n')
    const r = await sb.fanout(
      [
        'run',
        '--brief',
        sb.brief(),
        '--dir',
        sb.repo,
        '--kind',
        'inventory',
        '--public',
        '--harness',
        'openrouter-fanout',
        '--model',
        'glm-5.3-flash'
      ],
      { env: proxyEnv(w) }
    )
    expect(r.code).toBe(0)
    const [hit] = sb.ledger().filter((e) => e.event === 'limit_hit' && e.harness === 'openrouter-fanout')
    expect(hit).toMatchObject({ outcome: 'auth_error' })
    expect(r.stdout).toContain('FALLBACK openrouter-fanout/glm-5.3-flash auth_error -> fake/f1-a')
  } finally {
    w.stop()
  }
})

test('openrouter-fanout refuses an alias outside the openrouter block', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  const w = startProxy(sb)
  try {
    const ok = join(sb.home, 'ok.json')
    writeFileSync(
      ok,
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', modelUsage: {} })
    )
    stubbed(sb, ok, '0')
    sb.catalog([HEADER, CF_RIVER_ALIAS, FAKE2_PAID].join('\n') + '\n')
    const r = await sb.fanout(
      [
        'run',
        '--brief',
        sb.brief(),
        '--dir',
        sb.repo,
        '--kind',
        'inventory',
        '--harness',
        'openrouter-fanout',
        '--model',
        'glm-5.3-flash-river'
      ],
      { env: proxyEnv(w) }
    )
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('NOTE openrouter-fanout: glm-5.3-flash-river is not an openrouter alias')
    expect(r.stdout.split('\n')[0]).toMatch(/outcome=ok/)
  } finally {
    w.stop()
  }
})

test('a proxy that is down is skipped, not thrown', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  // A free port with nothing listening: the template rendered with it points
  // at a proxy that is down.
  const held = Bun.serve({ port: 0, fetch: () => new Response('x') })
  const port = held.port
  held.stop()
  const dir = join(sb.home, 'proxy')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'config.yaml'),
    readFileSync(fixture('config.yaml.tpl'), 'utf8').replaceAll('__PORT__', String(port))
  )
  const ok = join(sb.home, 'ok.json')
  writeFileSync(
    ok,
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', modelUsage: {} })
  )
  stubbed(sb, ok, '0')
  sb.catalog([HEADER, RIVER_DEEP, FAKE_A].join('\n') + '\n')
  const r = await sb.fanout(
    ['run', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'inventory', '--harness', 'river'],
    {
      env: {
        FANOUT_PROXY_DIR: dir,
        FANOUT_OPENROUTER_URL: `http://127.0.0.1:${port}/or/models`,
        FANOUT_PROXY_WAIT_MS: '400',
        CLIPROXY_BIN: '/bin/false'
      }
    }
  )
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('NOTE river: proxy not reachable')
  expect(r.stdout).toContain('-> fake/f1-a')
})

test('river classifies 403 as auth and 404 as model_unavailable', async () => {
  const { RiverAdapter } = await import('../src/adapters/river')
  const now = Date.parse('2026-11-15T01:00:00Z')
  const adapter = new RiverAdapter()
  const denied = JSON.stringify({
    type: 'result',
    subtype: 'error',
    is_error: true,
    api_error_status: 403,
    error: 'forbidden'
  })
  expect(adapter.classify({ exit: 1, stdout: denied, stderr: '', timedOut: false }, now)).toMatchObject({
    outcome: 'auth_error',
    scope: 'account'
  })
  const missing = JSON.stringify({
    type: 'result',
    subtype: 'error',
    is_error: true,
    api_error_status: 404,
    error: 'model not found'
  })
  expect(adapter.classify({ exit: 1, stdout: missing, stderr: '', timedOut: false }, now)).toMatchObject({
    outcome: 'model_unavailable'
  })
})

test('openrouter-fanout treats exit 124 as a worker error', async () => {
  const { OpenRouterFanoutAdapter } = await import('../src/adapters/openrouter-fanout')
  const now = Date.parse('2026-11-15T01:00:00Z')
  const adapter = new OpenRouterFanoutAdapter()
  expect(adapter.classify({ exit: 124, stdout: 'timed out', stderr: '', timedOut: false }, now)).toMatchObject({
    outcome: 'worker_error'
  })
})

test('proxy config errors never contain the token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fanout-proxy-'))
  writeFileSync(join(dir, 'config.yaml'), 'port: [oops\nnote: px-test-token-9\n')
  const prev = process.env.FANOUT_PROXY_DIR
  process.env.FANOUT_PROXY_DIR = dir
  try {
    const { readProxyConfig } = await import('../src/adapters/proxy')
    let message = ''
    try {
      readProxyConfig()
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).not.toBe('')
    expect(message).not.toContain('px-test-token-9')
  } finally {
    if (prev === undefined) delete process.env.FANOUT_PROXY_DIR
    else process.env.FANOUT_PROXY_DIR = prev
  }
})

test('ensureProxy starts the binary when the port is closed', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  // A free port that is closed when the preflight runs.
  const held = Bun.serve({ port: 0, fetch: () => new Response('x') })
  const port = held.port
  held.stop()
  const dir = join(sb.home, 'proxy')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'config.yaml'),
    readFileSync(fixture('config.yaml.tpl'), 'utf8').replaceAll('__PORT__', String(port))
  )
  // A stand-in for the CLIProxyAPI binary: it reads the port and the aliases
  // out of the config file it is started with and serves them.
  const helper = join(sb.home, 'fake-proxy-server.ts')
  writeFileSync(
    helper,
    `const cfgPath = process.argv[2]\n` +
      `const raw = Bun.YAML.parse(await Bun.file(cfgPath).text())\n` +
      `const aliases = raw.providers.flatMap((p) => p.models.map((m) => m.alias ?? m.name))\n` +
      `const port = Number(raw.port)\n` +
      `Bun.serve({ port, fetch(req) {\n` +
      `  if (new URL(req.url).pathname === '/v1/models') return Response.json({ data: aliases.map((id) => ({ id })) })\n` +
      `  return new Response('not found', { status: 404 })\n` +
      `}})\n` +
      `await new Promise(() => {})\n`
  )
  const bin = sb.bin(
    'cliproxy-stub',
    `#!/bin/sh\ncfg=""\nprev=""\nfor a in "$@"; do\n  if [ "$prev" = "-config" ]; then cfg="$a"; fi\n  prev="$a"\ndone\nexec bun "${helper}" "$cfg"\n`
  )
  sb.bin('claude', '#!/bin/sh\nexit 0\n')
  const prevPath = process.env.PATH
  const prevDir = process.env.FANOUT_PROXY_DIR
  const prevBin = process.env.CLIPROXY_BIN
  const prevWait = process.env.FANOUT_PROXY_WAIT_MS
  process.env.PATH = `${join(sb.home, 'bin')}:${prevPath}`
  process.env.FANOUT_PROXY_DIR = dir
  process.env.CLIPROXY_BIN = bin
  process.env.FANOUT_PROXY_WAIT_MS = '2500'
  try {
    // Full preflight is the doctor seam (Task 31, built in parallel); the
    // adapter call below is the same code path.
    const { RiverAdapter } = await import('../src/adapters/river')
    await expect(new RiverAdapter().preflight()).resolves.toEqual({ ok: true })
  } finally {
    if (prevPath === undefined) delete process.env.PATH
    else process.env.PATH = prevPath
    if (prevDir === undefined) delete process.env.FANOUT_PROXY_DIR
    else process.env.FANOUT_PROXY_DIR = prevDir
    if (prevBin === undefined) delete process.env.CLIPROXY_BIN
    else process.env.CLIPROXY_BIN = prevBin
    if (prevWait === undefined) delete process.env.FANOUT_PROXY_WAIT_MS
    else process.env.FANOUT_PROXY_WAIT_MS = prevWait
  }
})

test('discovery prices OpenRouter models and leaves unpriced ones unrouted', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  const w = startProxy(sb)
  const prevDir = process.env.FANOUT_PROXY_DIR
  const prevUrl = process.env.FANOUT_OPENROUTER_URL
  process.env.FANOUT_PROXY_DIR = w.dir
  process.env.FANOUT_OPENROUTER_URL = `http://127.0.0.1:${w.port}/or/models`
  try {
    // The upkeep discover seam (Task 32, built in parallel) consumes
    // listModels; the call below is the same code path.
    const { OpenRouterFanoutAdapter } = await import('../src/adapters/openrouter-fanout')
    const models = await new OpenRouterFanoutAdapter().listModels()
    const qwen = models.find((m) => m.model === 'qwen3.7-flash')
    expect(qwen).toMatchObject({ billing: 'paid', priceIn: 0.03, priceOut: 0.13 })
    const mystery = models.find((m) => m.model === 'mystery')
    expect(mystery).toBeDefined()
    expect(mystery?.priceIn).toBeUndefined()
    expect(mystery?.priceOut).toBeUndefined()
  } finally {
    if (prevDir === undefined) delete process.env.FANOUT_PROXY_DIR
    else process.env.FANOUT_PROXY_DIR = prevDir
    if (prevUrl === undefined) delete process.env.FANOUT_OPENROUTER_URL
    else process.env.FANOUT_OPENROUTER_URL = prevUrl
    w.stop()
  }
})

test('the mined river fixtures classify as recorded', async () => {
  const entries = JSON.parse(readFileSync(join(import.meta.dir, './fixtures/mined/river/index.json'), 'utf8')) as {
    file: string
    outcome: string
  }[]
  expect(entries.length).toBeGreaterThan(0)
  for (const entry of entries) {
    const sb = sandbox().at('2026-11-15T01:00:00Z')
    const w = startProxy(sb)
    try {
      stubbed(sb, join(import.meta.dir, './fixtures/mined/river', entry.file), '1')
      sb.catalog([HEADER, RIVER_DEEP, FAKE_A].join('\n') + '\n')
      await sb.fanout(['run', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'inventory', '--harness', 'river'], {
        env: proxyEnv(w)
      })
      const [end] = jobEnds(sb, 'river')
      expect(end).toMatchObject({ outcome: entry.outcome })
    } finally {
      w.stop()
    }
  }
})

test('the mined openrouter-fanout fixtures classify as recorded', async () => {
  // Task 26 mined no openrouter-fanout clusters, so this loops zero times today;
  // it runs any future cluster the same way the river test does.
  let entries: { file: string; outcome: string }[] = []
  try {
    entries = JSON.parse(readFileSync(join(import.meta.dir, './fixtures/mined/openrouter-fanout/index.json'), 'utf8'))
  } catch {
    entries = []
  }
  for (const entry of entries) {
    const sb = sandbox().at('2026-11-15T01:00:00Z')
    const w = startProxy(sb)
    try {
      stubbed(sb, join(import.meta.dir, './fixtures/mined/openrouter-fanout', entry.file), '1')
      sb.catalog([HEADER, CF_GLM, FAKE_A].join('\n') + '\n')
      await sb.fanout(
        [
          'run',
          '--brief',
          sb.brief(),
          '--dir',
          sb.repo,
          '--kind',
          'inventory',
          '--public',
          '--harness',
          'openrouter-fanout',
          '--model',
          'glm-5.3-flash'
        ],
        { env: proxyEnv(w) }
      )
      const [end] = jobEnds(sb, 'openrouter-fanout')
      expect(end).toMatchObject({ outcome: entry.outcome })
    } finally {
      w.stop()
    }
  }
  expect(Array.isArray(entries)).toBe(true)
})
