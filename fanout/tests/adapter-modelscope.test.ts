import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sandbox } from './helpers/sandbox'
import { ModelScopeAdapter, proxyDir } from '../src/adapters/modelscope'
import { denials } from '../src/adapters/claude-cli'
import { renderBlock } from '../src/result'

const HEADER =
  'harness,model,efforts,tier,billing,price_in,price_cached,price_out,price_call,min_brief_bytes,data_class,status,family,aliases,aa_slug,climb,upstream,note'
const MS_ROW = 'modelscope,Qwen/Qwen3.8-27B,,2,per_call,,,,1,6000,any,active,Qwen/Qwen3.8-27B,,,,1 MC per call,'
const MS_NOT_LIVE_ROW = 'modelscope,ms-not-live,,1,per_call,,,,2,0,any,active,ms-not-live,,,,,'
const FAKE_ROW = 'fake,f1-a,medium|low,1,subscription,,,,,0,any,active,f1-a,,,,,'

function tpl(): string {
  return readFileSync(join(import.meta.dir, './fixtures/modelscope/config.yaml.tpl'), 'utf8')
}

function proxyLogFixture(): string {
  return readFileSync(join(import.meta.dir, './fixtures/modelscope/proxy.log.txt'), 'utf8')
}

function startProxy(routes: { id: string; owned_by: string }[]) {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url)
      if (url.pathname === '/v1/models') return Response.json({ data: routes })
      return new Response('not found', { status: 404 })
    }
  })
}

function liveRoutes() {
  return [
    { id: 'ms-qwen3.8-27b', owned_by: 'modelscope' },
    { id: 'ms-qwen3.8-57b', owned_by: 'modelscope' }
  ]
}

function writeProxyDir(port: number, text: string = tpl()): string {
  const dir = mkdtempSync(join(tmpdir(), 'fanout-ms-proxy-'))
  writeFileSync(join(dir, 'config.yaml'), text.replace('__PORT__', String(port)))
  return dir
}

function stubbed(sb: ReturnType<typeof sandbox>, out: string, exit: string) {
  const argv = join(sb.home, 'stub-argv')
  const stdin = join(sb.home, 'stub-stdin')
  const env = join(sb.home, 'stub-env')
  const outFile = join(sb.home, 'stub-out.txt')
  writeFileSync(outFile, out)
  // Paths are baked into the script: the worker only inherits the allowlist,
  // so the stub cannot rely on extra environment variables.
  sb.bin(
    'claude',
    `#!/bin/sh\nprintf '%s\\n' "$0" "$@" > "${argv}"\ncat > "${stdin}"\nenv > "${env}"\ncat "${outFile}"\nexit ${exit}\n`
  )
  return { argv, stdin, env }
}

function readLines(p: string): string[] {
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

function successResult(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done',
    modelUsage: {},
    permission_denials: [],
    ...extra
  })
}

function withTZ<T>(fn: () => T): T {
  const prev = process.env.TZ
  process.env.TZ = 'Asia/Kuala_Lumpur'
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.TZ
    else process.env.TZ = prev
  }
}

// 2026-11-15 09:00:00 in Asia/Kuala_Lumpur (UTC+8), matching proxy.log.txt.
const WINDOW_START = Date.UTC(2026, 10, 15, 9, 0, 0) - 8 * 3600 * 1000
const WINDOW_END = WINDOW_START + 6000

async function measuredCalls(logText: string, endMs: number): Promise<unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'fanout-ms-log-'))
  const log = join(dir, 'proxy.log')
  writeFileSync(log, logText)
  utimesSync(log, new Date(endMs), new Date(endMs))
  const prev = process.env.FANOUT_PROXY_DIR
  process.env.FANOUT_PROXY_DIR = dir
  try {
    return await withTZ(() =>
      new ModelScopeAdapter().measure({
        startMs: WINDOW_START,
        endMs,
        route: 'ms-qwen3.8-27b',
        overlapped: false
      })
    )
  } finally {
    if (prev === undefined) delete process.env.FANOUT_PROXY_DIR
    else process.env.FANOUT_PROXY_DIR = prev
  }
}

test('the dry-run argv has no effort and the right tools', async () => {
  const server = startProxy(liveRoutes())
  try {
    const sb = sandbox()
    const dir = writeProxyDir(server.port)
    sb.catalog(`${HEADER}\n${MS_ROW}\n${FAKE_ROW}\n`)
    const r = await sb.fanout(
      [
        'run',
        '--dry-run',
        '--harness',
        'modelscope',
        '--model',
        'Qwen/Qwen3.8-27B',
        '--brief',
        sb.brief('Rename foo to bar in a.txt, nothing else.', 7000),
        '--dir',
        sb.repo,
        '--kind',
        'inventory'
      ],
      { env: { FANOUT_PROXY_DIR: dir } }
    )
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('"--tools"')
    expect(r.stdout).toContain('"Read,Edit,Write,Glob,Grep"')
    expect(r.stdout).toContain('"--no-session-persistence"')
    expect(r.stdout).toContain('"--max-turns","8"')
    expect(r.stdout).not.toContain('--effort')
  } finally {
    server.stop()
  }
})

test('the stub environment is clean and pinned', async () => {
  const server = startProxy(liveRoutes())
  try {
    const sb = sandbox()
    const dir = writeProxyDir(server.port)
    const stub = stubbed(sb, successResult(), '0')
    sb.catalog(`${HEADER}\n${MS_ROW}\n${FAKE_ROW}\n`)
    const r = await sb.fanout(
      [
        'run',
        '--harness',
        'modelscope',
        '--model',
        'Qwen/Qwen3.8-27B',
        '--brief',
        sb.brief('Rename foo to bar in a.txt, nothing else.', 7000),
        '--dir',
        sb.repo,
        '--kind',
        'inventory'
      ],
      {
        env: {
          FANOUT_PROXY_DIR: dir,
          OPENROUTER_API_KEY: 'parent-key',
          ANTHROPIC_MODEL: 'other'
        }
      }
    )
    expect(r.code).toBe(0)
    const env = readEnv(stub.env)
    expect(env.get('ANTHROPIC_BASE_URL')).toBe(`http://127.0.0.1:${server.port}`)
    expect(env.get('ANTHROPIC_MODEL')).toBe('ms-qwen3.8-27b')
    expect(env.get('ANTHROPIC_AUTH_TOKEN')).toBe('ms-test-key')
    expect(env.get('CLAUDE_CONFIG_DIR') ?? '').toMatch(/\/\.modelscope-fanout$/)
    expect(env.has('OPENROUTER_API_KEY')).toBe(false)
    expect(env.has('ANTHROPIC_API_KEY')).toBe(false)
    expect(statSync(env.get('CLAUDE_CONFIG_DIR') ?? '').mode & 0o777).toBe(0o700)
    expect(r.stdout).not.toContain('ms-test-key')
  } finally {
    server.stop()
  }
})

test('stdin starts with the working-directory sentence', async () => {
  const server = startProxy(liveRoutes())
  try {
    const sb = sandbox()
    const dir = writeProxyDir(server.port)
    const stub = stubbed(sb, successResult(), '0')
    sb.catalog(`${HEADER}\n${MS_ROW}\n${FAKE_ROW}\n`)
    const briefText = 'Rename foo to bar in a.txt, nothing else.'
    const r = await sb.fanout(
      [
        'run',
        '--harness',
        'modelscope',
        '--model',
        'Qwen/Qwen3.8-27B',
        '--brief',
        sb.brief(briefText, 7000),
        '--dir',
        sb.repo,
        '--kind',
        'inventory'
      ],
      { env: { FANOUT_PROXY_DIR: dir } }
    )
    expect(r.code).toBe(0)
    const stdin = readFileSync(stub.stdin, 'utf8')
    expect(stdin.startsWith('Your working directory is ')).toBe(true)
    const [first, ...rest] = stdin.split('\n\n')
    expect(first.endsWith('Never guess a home-directory path.')).toBe(true)
    expect(rest.join('\n\n')).toContain(briefText)
  } finally {
    server.stop()
  }
})

test('a bad routing config is refused without echoing it', async () => {
  const marker = 'zz-unique-marker-9'
  const cases: [string, string][] = [
    [
      'two providers',
      tpl().replace(
        '  - name: openrouter',
        `  - name: modelscope\n    baseUrl: https://api-inference.modelscope.ai/v1\n    api-keys:\n      - ${marker}\n    models:\n      - name: other/model\n  - name: openrouter`
      )
    ],
    ['duplicate alias', tpl().replace('alias: ms-qwen3.8-57b', `alias: ms-qwen3.8-27b # ${marker}`)],
    ['alias collision', tpl().replace('alias: ms-qwen3.8-57b', `alias: glm-5.3-flash # ${marker}`)]
  ]
  for (const [, config] of cases) {
    const server = startProxy(liveRoutes())
    try {
      const sb = sandbox()
      stubbed(sb, successResult(), '0')
      const dir = writeProxyDir(server.port, config)
      sb.catalog(`${HEADER}\n${MS_ROW}\n${FAKE_ROW}\n`)
      const r = await sb.fanout(
        [
          'run',
          '--harness',
          'modelscope',
          '--model',
          'Qwen/Qwen3.8-27B',
          '--brief',
          sb.brief('Rename foo to bar in a.txt, nothing else.', 7000),
          '--dir',
          sb.repo,
          '--kind',
          'inventory'
        ],
        { env: { FANOUT_PROXY_DIR: dir } }
      )
      expect(r.stdout).toContain('NOTE modelscope: invalid ModelScope routing config')
      expect(r.stdout).not.toContain(marker)
      expect(r.stderr).not.toContain(marker)
    } finally {
      server.stop()
    }
  }
})

test('a model that is not a live route is skipped, never rerouted', async () => {
  const server = startProxy(liveRoutes())
  try {
    const sb = sandbox()
    const dir = writeProxyDir(server.port)
    stubbed(sb, successResult(), '0')
    sb.catalog(`${HEADER}\n${MS_NOT_LIVE_ROW}\n${MS_ROW}\n${FAKE_ROW}\n`)
    const r = await sb.fanout(
      [
        'run',
        '--harness',
        'modelscope',
        '--model',
        'ms-not-live',
        '--brief',
        sb.brief('Rename foo to bar in a.txt, nothing else.', 7000),
        '--dir',
        sb.repo,
        '--kind',
        'inventory'
      ],
      { env: { FANOUT_PROXY_DIR: dir } }
    )
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('NOTE modelscope: not a live ModelScope route')
    const starts = sb.ledger().filter((e) => e.event === 'job_start')
    expect(starts.length).toBeGreaterThan(0)
    expect(starts.every((e) => e.model !== 'ms-not-live')).toBe(true)
  } finally {
    server.stop()
  }
})

test('per-call pricing and the chunk-size rule', async () => {
  const sb = sandbox()
  sb.catalog(`${HEADER}\n${MS_ROW}\n${FAKE_ROW}\n`)
  const big = await sb.fanout(
    [
      'pick',
      '--brief',
      sb.brief('Rename foo to bar in a.txt, nothing else.', 7000),
      '--dir',
      sb.repo,
      '--kind',
      'inventory'
    ],
    { env: { FANOUT_PROBE: 'private' } }
  )
  expect(big.code).toBe(0)
  expect(big.stdout).toContain('PAID modelscope/Qwen/Qwen3.8-27B ESTIMATE 8 MC (8 turns x 1 MC, upper-bound guess)')
  const small = await sb.fanout(
    [
      'pick',
      '--all',
      '--brief',
      sb.brief('Rename foo to bar in a.txt, nothing else.', 100),
      '--dir',
      sb.repo,
      '--kind',
      'inventory'
    ],
    { env: { FANOUT_PROBE: 'private' } }
  )
  expect(small.code).toBe(0)
  expect(small.stdout).not.toContain('modelscope/')
})

test('six calls in the window are counted', async () => {
  const measured = await measuredCalls(proxyLogFixture(), WINDOW_END)
  expect(measured).toEqual({ calls: 6 })
})

test('unmeasurable cases say so', async () => {
  const adapter = new ModelScopeAdapter()
  const prev = process.env.FANOUT_PROXY_DIR
  const runMeasure = (dir: string | undefined, o: { overlapped?: boolean; endMs?: number } = {}) =>
    withTZ(async () => {
      if (dir === undefined) delete process.env.FANOUT_PROXY_DIR
      else process.env.FANOUT_PROXY_DIR = dir
      return adapter.measure({
        startMs: WINDOW_START,
        endMs: o.endMs ?? WINDOW_END,
        route: 'ms-qwen3.8-27b',
        overlapped: o.overlapped ?? false
      })
    })
  try {
    // Overlapping jobs share one proxy log, so attribution is impossible.
    const overlappedDir = mkdtempSync(join(tmpdir(), 'fanout-ms-log-'))
    const overlappedLog = join(overlappedDir, 'proxy.log')
    writeFileSync(overlappedLog, proxyLogFixture())
    utimesSync(overlappedLog, new Date(WINDOW_END), new Date(WINDOW_END))
    expect(await runMeasure(overlappedDir, { overlapped: true })).toBe('unmeasured')
    // A missing log cannot be measured.
    expect(await runMeasure(join(tmpdir(), 'fanout-ms-absent'), {})).toBe('unmeasured')
    // A log older than the job end is stale.
    const staleDir = mkdtempSync(join(tmpdir(), 'fanout-ms-log-'))
    const staleLog = join(staleDir, 'proxy.log')
    writeFileSync(staleLog, proxyLogFixture())
    utimesSync(staleLog, new Date(WINDOW_END - 3600 * 1000), new Date(WINDOW_END - 3600 * 1000))
    expect(await runMeasure(staleDir, {})).toBe('unmeasured')
    // A log with no gin lines cannot be measured.
    const emptyDir = mkdtempSync(join(tmpdir(), 'fanout-ms-log-'))
    const emptyLog = join(emptyDir, 'proxy.log')
    writeFileSync(emptyLog, 'proxy started\n')
    utimesSync(emptyLog, new Date(WINDOW_END), new Date(WINDOW_END))
    expect(await runMeasure(emptyDir, {})).toBe('unmeasured')
  } finally {
    if (prev === undefined) delete process.env.FANOUT_PROXY_DIR
    else process.env.FANOUT_PROXY_DIR = prev
  }
})

test('exit 0 without a success result is a worker error', async () => {
  const server = startProxy(liveRoutes())
  try {
    const sb = sandbox()
    const dir = writeProxyDir(server.port)
    stubbed(sb, successResult({ is_error: true }), '0')
    sb.catalog(`${HEADER}\n${MS_ROW}\n${FAKE_ROW}\n`)
    const r = await sb.fanout(
      [
        'run',
        '--harness',
        'modelscope',
        '--model',
        'Qwen/Qwen3.8-27B',
        '--brief',
        sb.brief('Rename foo to bar in a.txt, nothing else.', 7000),
        '--dir',
        sb.repo,
        '--kind',
        'inventory'
      ],
      { env: { FANOUT_PROXY_DIR: dir } }
    )
    expect(r.code).toBe(0)
    const [end] = sb.ledger().filter((e) => e.event === 'job_end' && e.harness === 'modelscope')
    expect(end).toMatchObject({ outcome: 'worker_error' })
    expect(r.stdout).toContain('FALLBACK modelscope/Qwen/Qwen3.8-27B worker_error -> fake/f1-a')
  } finally {
    server.stop()
  }
})

test('a turn cap is a job error', async () => {
  const server = startProxy(liveRoutes())
  try {
    const sb = sandbox()
    const dir = writeProxyDir(server.port)
    stubbed(sb, successResult({ subtype: 'error_max_turns', is_error: true }), '1')
    sb.catalog(`${HEADER}\n${MS_ROW}\n${FAKE_ROW}\n`)
    const r = await sb.fanout(
      [
        'run',
        '--harness',
        'modelscope',
        '--model',
        'Qwen/Qwen3.8-27B',
        '--brief',
        sb.brief('Rename foo to bar in a.txt, nothing else.', 7000),
        '--dir',
        sb.repo,
        '--kind',
        'inventory'
      ],
      { env: { FANOUT_PROXY_DIR: dir } }
    )
    expect(r.code).toBe(1)
    expect(r.stdout.split('\n')[0]).toMatch(/outcome=job_error/)
    expect(r.stdout).not.toContain('FALLBACK')
    const [end] = sb.ledger().filter((e) => e.event === 'job_end' && e.harness === 'modelscope')
    expect(end).toMatchObject({ outcome: 'job_error' })
  } finally {
    server.stop()
  }
})

test('denials are reported', () => {
  const stdout = successResult({ permission_denials: [{ tool: 'Bash' }, { tool: 'Write' }] })
  expect(denials(stdout)).toBe(2)
  const block = renderBlock({
    job: 'J',
    harness: 'modelscope',
    model: 'Qwen/Qwen3.8-27B',
    outcome: 'ok',
    attempt: 1,
    denials: denials(stdout)
  })
  expect(block.block).toContain('DENIALS=2')
})

test('discovery lists live ModelScope upstreams as per-call', async () => {
  const server = startProxy(liveRoutes())
  const prev = process.env.FANOUT_PROXY_DIR
  try {
    const dir = writeProxyDir(server.port)
    process.env.FANOUT_PROXY_DIR = dir
    const models = await new ModelScopeAdapter().listModels()
    expect(models).toEqual([
      {
        model: 'Qwen/Qwen3.8-27B',
        efforts: [],
        billing: 'per_call',
        priceCall: 1,
        dataClass: 'any'
      },
      {
        model: 'Qwen/Qwen3.8-57B',
        efforts: [],
        billing: 'per_call',
        priceCall: 2,
        dataClass: 'any'
      }
    ])
  } finally {
    if (prev === undefined) delete process.env.FANOUT_PROXY_DIR
    else process.env.FANOUT_PROXY_DIR = prev
    server.stop()
  }
})

test('the proxy dir defaults under home', () => {
  const prevHome = process.env.HOME
  const prevDir = process.env.FANOUT_PROXY_DIR
  const home = mkdtempSync(join(tmpdir(), 'fanout-ms-home-'))
  process.env.HOME = home
  delete process.env.FANOUT_PROXY_DIR
  try {
    expect(proxyDir()).toBe(join(home, '.cli-proxy-api'))
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevDir === undefined) delete process.env.FANOUT_PROXY_DIR
    else process.env.FANOUT_PROXY_DIR = prevDir
  }
})
