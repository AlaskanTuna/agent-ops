import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sandbox } from './helpers/sandbox'
import { MetaAdapter } from '../src/adapters/meta'
import { denials } from '../src/adapters/claude-cli'
import { renderBlock } from '../src/result'
import metaIndex from './fixtures/mined/meta/index.json'

const HEADER =
  'harness,model,efforts,tier,billing,price_in,price_cached,price_out,price_call,min_brief_bytes,data_class,status,family,aliases,aa_slug,climb,upstream,note'
const CONTRIBUTOR =
  'meta,muse-spark-1.3-contributor,max|xhigh|high|low,1,paid,0.10,0.002,0.20,,0,public-only,active,muse-spark,,,,,'
const FAKE_PAID = 'fake2,f1-paid,medium|low,1,paid,1.00,0.10,2.00,,0,any,active,fam-paid,,,,,'
const META_URL = 'http://127.0.0.1:9'

function fixture(name: string): string {
  return join(import.meta.dir, './fixtures/meta', name)
}

function minedFixture(name: string): string {
  return join(import.meta.dir, './fixtures/mined/meta', name)
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

function secretsFile(sb: ReturnType<typeof sandbox>, key: string): string {
  const p = join(sb.home, 'secrets')
  writeFileSync(p, `META_MODEL_API_KEY=${key}\n`)
  return p
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

function baseEnv(sb: ReturnType<typeof sandbox>, key: string) {
  return {
    META_MODEL_API_KEY: undefined,
    FANOUT_SECRETS: secretsFile(sb, key),
    ANTHROPIC_API_KEY: undefined,
    FANOUT_META_URL: META_URL
  }
}

function jobEnds(sb: ReturnType<typeof sandbox>, harness: string): Record<string, unknown>[] {
  return sb.ledger().filter((e) => e.event === 'job_end' && e.harness === harness)
}

test('a contributor model at max effort is rounded and the key is hidden', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  const key = `meta-test-${randomUUID()}`
  const stub = stubbed(sb, fixture('ok.txt'), '0')
  sb.catalog(`${HEADER}\n${CONTRIBUTOR}\n${FAKE_PAID}\n`)
  const r = await sb.fanout(
    [
      'run',
      '--brief',
      sb.brief('Rename foo to bar in a.txt, nothing else.'),
      '--dir',
      sb.repo,
      '--kind',
      'transcribe',
      '--public'
    ],
    {
      env: {
        ...baseEnv(sb, key)
      }
    }
  )
  expect(r.code).toBe(0)
  const argv = readArgv(stub.argv)
  const [zero, ...rest] = argv
  expect(zero).toMatch(/\/bin\/claude$/)
  expect(rest).toEqual([
    '-p',
    '--model',
    'muse-spark-1.3-contributor',
    '--effort',
    'xhigh',
    '--permission-mode',
    'acceptEdits',
    '--max-turns',
    '8',
    '--output-format',
    'json'
  ])
  expect(argv.join('\n')).not.toContain(key)
  expect(r.stdout).not.toContain(key)
  expect(r.stderr).not.toContain(key)
})

test('max effort passes through on a non-contributor model', () => {
  const key = `meta-test-${randomUUID()}`
  const prevKey = process.env.META_MODEL_API_KEY
  const prevHome = process.env.HOME
  const home = mkdtempSync(join(tmpdir(), 'fanout-unit-home-'))
  process.env.META_MODEL_API_KEY = key
  process.env.HOME = home
  try {
    const built = new MetaAdapter().build({
      model: 'muse-spark-1.3',
      effort: 'max',
      cwd: home,
      briefPath: join(home, 'b.txt'),
      job: 'J',
      outDir: home,
      timeoutS: 1500,
      maxTurns: 40,
      bypass: false,
      allow: []
    })
    const i = built.argv.indexOf('--effort')
    expect(i).toBeGreaterThan(-1)
    expect(built.argv[i + 1]).toBe('max')
  } finally {
    if (prevKey === undefined) delete process.env.META_MODEL_API_KEY
    else process.env.META_MODEL_API_KEY = prevKey
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
  }
})

test('the stub environment is isolated', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  const key = `meta-test-${randomUUID()}`
  const stub = stubbed(sb, fixture('ok.txt'), '0')
  sb.catalog(`${HEADER}\n${CONTRIBUTOR}\n${FAKE_PAID}\n`)
  const r = await sb.fanout(
    [
      'run',
      '--brief',
      sb.brief('Rename foo to bar in a.txt, nothing else.'),
      '--dir',
      sb.repo,
      '--kind',
      'transcribe',
      '--public'
    ],
    {
      env: {
        ...baseEnv(sb, key),
        ANTHROPIC_API_KEY: 'parent-key'
      }
    }
  )
  expect(r.code).toBe(0)
  const env = readEnv(stub.env)
  expect(env.get('ANTHROPIC_BASE_URL')).toBe(META_URL)
  expect(env.get('ANTHROPIC_MODEL')).toBe('muse-spark-1.3-contributor')
  expect(env.get('CLAUDE_CONFIG_DIR') ?? '').toMatch(/\/\.claude-fanout$/)
  expect(env.get('ANTHROPIC_AUTH_TOKEN')).toBe(key)
  expect(env.has('ANTHROPIC_API_KEY')).toBe(false)
  const dir = env.get('CLAUDE_CONFIG_DIR') ?? ''
  expect(readdirSync(dir)).toEqual([])
})

test('usage is summed from modelUsage and the cost is computed', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  const key = `meta-test-${randomUUID()}`
  const stub = stubbed(sb, fixture('ok.txt'), '0')
  sb.catalog(`${HEADER}\n${CONTRIBUTOR}\n${FAKE_PAID}\n`)
  const r = await sb.fanout(
    [
      'run',
      '--brief',
      sb.brief('Rename foo to bar in a.txt, nothing else.'),
      '--dir',
      sb.repo,
      '--kind',
      'transcribe',
      '--public'
    ],
    {
      env: {
        ...baseEnv(sb, key)
      }
    }
  )
  expect(r.code).toBe(0)
  expect(r.stdout.split('\n')[0]).toMatch(/model=muse-spark-1\.3-contributor outcome=ok/)
  const [end] = jobEnds(sb, 'meta')
  expect(end).toMatchObject({
    outcome: 'ok',
    tokens_in: 1000000,
    tokens_cached: 2000000,
    tokens_out: 100000,
    cost_source: 'computed'
  })
  // (1e6 x 0.10 + 2e6 x 0.002 + 1e5 x 0.20) / 1e6 = 0.124; total_cost_usd is never read
  expect(r.stdout).not.toContain('9.99')
})

test('401, 402 and 429 map to outcomes and fall back', async () => {
  const cases: [string, string, string][] = [
    ['401.txt', 'auth_error', 'account'],
    ['402.txt', 'credits_exhausted', 'account'],
    ['429.txt', 'rate_limited', 'model']
  ]
  for (const [fix, outcome, scope] of cases) {
    const sb = sandbox().at('2026-11-15T01:00:00Z')
    const key = `meta-test-${randomUUID()}`
    const stub = stubbed(sb, fix, '1')
    sb.catalog(`${HEADER}\n${CONTRIBUTOR}\n${FAKE_PAID}\n`)
    const r = await sb.fanout(
      [
        'run',
        '--brief',
        sb.brief('Rename foo to bar in a.txt, nothing else.'),
        '--dir',
        sb.repo,
        '--kind',
        'transcribe',
        '--public'
      ],
      {
        env: {
          ...baseEnv(sb, key)
        }
      }
    )
    expect(r.code).toBe(0)
    const [end] = jobEnds(sb, 'meta')
    expect(end).toMatchObject({ outcome })
    const [hit] = sb.ledger().filter((e) => e.event === 'limit_hit' && e.harness === 'meta')
    expect(hit).toMatchObject({ outcome, scope })
    expect(r.stdout).toContain(`FALLBACK meta/muse-spark-1.3-contributor ${outcome} -> fake2/f1-paid`)
  }
})

test('a turn cap is a job error', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  const key = `meta-test-${randomUUID()}`
  const stub = stubbed(sb, fixture('max-turns.txt'), '1')
  sb.catalog(`${HEADER}\n${CONTRIBUTOR}\n`)
  const r = await sb.fanout(
    [
      'run',
      '--brief',
      sb.brief('Rename foo to bar in a.txt, nothing else.'),
      '--dir',
      sb.repo,
      '--kind',
      'transcribe',
      '--public'
    ],
    {
      env: {
        ...baseEnv(sb, key)
      }
    }
  )
  expect(r.code).toBe(1)
  expect(r.stdout.split('\n')[0]).toMatch(/outcome=job_error/)
  expect(r.stdout).not.toContain('FALLBACK')
  expect(sb.ledger().filter((e) => e.event === 'job_start')).toHaveLength(1)
  const [end] = jobEnds(sb, 'meta')
  expect(end).toMatchObject({ outcome: 'job_error' })
})

test('denials are reported', () => {
  const stdout = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done',
    modelUsage: {},
    permission_denials: [
      { tool: 'Bash', reason: 'nope' },
      { tool: 'Web', reason: 'nope' }
    ]
  })
  expect(denials(stdout)).toBe(2)
  const block = renderBlock({
    job: 'J',
    harness: 'meta',
    model: 'muse-spark-1.3-contributor',
    outcome: 'ok',
    attempt: 1,
    denials: denials(stdout)
  })
  expect(block.block).toContain('DENIALS=2')
})

test('a clean result that mentions 429 stays ok', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  const key = `meta-test-${randomUUID()}`
  const fix = join(sb.home, 'clean-429.txt')
  writeFileSync(
    fix,
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'see the 429 section of the docs for limits',
      modelUsage: {},
      permission_denials: []
    })
  )
  const stub = stubbed(sb, fix, '0')
  sb.catalog(`${HEADER}\n${CONTRIBUTOR}\n${FAKE_PAID}\n`)
  const r = await sb.fanout(
    [
      'run',
      '--brief',
      sb.brief('Rename foo to bar in a.txt, nothing else.'),
      '--dir',
      sb.repo,
      '--kind',
      'transcribe',
      '--public'
    ],
    {
      env: {
        ...baseEnv(sb, key)
      }
    }
  )
  expect(r.code).toBe(0)
  const [end] = jobEnds(sb, 'meta')
  expect(end).toMatchObject({ outcome: 'ok' })
})

test('--allow and --bypass reach the argv', () => {
  const key = `meta-test-${randomUUID()}`
  const prevKey = process.env.META_MODEL_API_KEY
  const prevHome = process.env.HOME
  const home = mkdtempSync(join(tmpdir(), 'fanout-unit-home-'))
  process.env.META_MODEL_API_KEY = key
  process.env.HOME = home
  try {
    const built = new MetaAdapter().build({
      model: 'muse-spark-1.3-contributor',
      effort: 'xhigh',
      cwd: home,
      briefPath: join(home, 'b.txt'),
      job: 'J',
      outDir: home,
      timeoutS: 1500,
      maxTurns: 40,
      bypass: true,
      allow: ['Bash(git status)']
    })
    expect(built.argv).toContain('--allowedTools')
    expect(built.argv).toContain('Bash(git status)')
    expect(built.argv).toContain('bypassPermissions')
    expect(built.argv).not.toContain('acceptEdits')
    expect(built.stdinPath).toBe(join(home, 'b.txt'))
    expect(built.secrets).toEqual([key])
  } finally {
    if (prevKey === undefined) delete process.env.META_MODEL_API_KEY
    else process.env.META_MODEL_API_KEY = prevKey
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
  }
})

test('no key on file skips the candidate', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  stubbed(sb, fixture('ok.txt'), '0')
  sb.catalog(`${HEADER}\n${CONTRIBUTOR}\n${FAKE_PAID}\n`)
  const r = await sb.fanout(
    [
      'run',
      '--brief',
      sb.brief('Rename foo to bar in a.txt, nothing else.'),
      '--dir',
      sb.repo,
      '--kind',
      'transcribe',
      '--public'
    ],
    {
      env: {
        META_MODEL_API_KEY: undefined,
        FANOUT_SECRETS: undefined,
        ANTHROPIC_API_KEY: undefined,
        FANOUT_META_URL: META_URL
      }
    }
  )
  expect(r.code).toBe(0)
  expect(r.stdout).toContain(
    'NOTE meta: no META_MODEL_API_KEY on file; the user adds it in their own terminal, never in the chat'
  )
  const [start] = sb.ledger().filter((e) => e.event === 'job_start')
  expect(start).toMatchObject({ harness: 'fake2', model: 'f1-paid' })
})

test('the key appears nowhere', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  const key = `meta-test-${randomUUID()}`
  const stub = stubbed(sb, fixture('ok.txt'), '0')
  sb.catalog(`${HEADER}\n${CONTRIBUTOR}\n${FAKE_PAID}\n`)
  const outside = mkdtempSync(join(tmpdir(), 'fanout-secrets-'))
  const secrets = join(outside, 'secrets')
  writeFileSync(secrets, `META_MODEL_API_KEY=${key}\n`)
  const r = await sb.fanout(
    [
      'run',
      '--brief',
      sb.brief('Rename foo to bar in a.txt, nothing else.'),
      '--dir',
      sb.repo,
      '--kind',
      'transcribe',
      '--public'
    ],
    {
      env: {
        META_MODEL_API_KEY: undefined,
        FANOUT_SECRETS: secrets,
        ANTHROPIC_API_KEY: undefined,
        FANOUT_META_URL: META_URL
      }
    }
  )
  expect(r.code).toBe(0)
  expect(r.stdout).not.toContain(key)
  expect(r.stderr).not.toContain(key)
  const { readdirSync: readdir, readFileSync: read, statSync: stat } = await import('node:fs')
  const found: string[] = []
  const walk = (dir: string) => {
    for (const f of readdir(dir, { withFileTypes: true })) {
      const p = join(dir, f.name)
      if (p === stub.env) continue
      if (f.isDirectory()) walk(p)
      else {
        try {
          if (stat(p).isFile() && read(p, 'utf8').includes(key)) found.push(p)
        } catch {
          // unreadable files cannot leak
        }
      }
    }
  }
  walk(sb.home)
  expect(found).toEqual([])
})

test('the mined fixtures classify as recorded', async () => {
  const entries = (metaIndex as { file: string; outcome: string }[]).filter((e) => e.outcome !== 'harmless')
  expect(entries.length).toBeGreaterThan(0)
  for (const entry of entries) {
    const sb = sandbox().at('2026-11-15T01:00:00Z')
    const key = `meta-test-${randomUUID()}`
    const stub = stubbed(sb, minedFixture(entry.file), '1')
    sb.catalog(`${HEADER}\n${CONTRIBUTOR}\n`)
    await sb.fanout(
      [
        'run',
        '--brief',
        sb.brief('Rename foo to bar in a.txt, nothing else.'),
        '--dir',
        sb.repo,
        '--kind',
        'transcribe',
        '--public'
      ],
      {
        env: {
          ...baseEnv(sb, key)
        }
      }
    )
    const [end] = jobEnds(sb, 'meta')
    expect(end).toMatchObject({ outcome: entry.outcome })
  }
})
