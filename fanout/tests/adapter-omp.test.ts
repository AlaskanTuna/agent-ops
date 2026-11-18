import { test, expect } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sandbox } from './helpers/sandbox'

type SB = ReturnType<typeof sandbox>

const HEADER =
  'harness,model,efforts,tier,billing,price_in,price_cached,price_out,price_call,min_brief_bytes,data_class,status,family,aliases,aa_slug,climb,upstream,note'
const OMP_ROW = 'omp,claude-haiku-5-5,medium|high,1,paid,0.10,0.01,0.50,,0,any,active,claude-haiku-5-5,,,,,'
const FAKE_ROW = 'fake,f1-a,medium,1,subscription,,,,,0,any,active,f1-a,,,,,'
// Built at runtime so no tracked file holds a key-shaped literal.
const KEY = ['sk', 'ant', 'fanout', 'test'].join('-')
const BRIEF = 'Rename foo in a.txt to bar, nothing else.'

function proxyDir(sb: SB, key: string | undefined): string {
  const dir = join(sb.home, 'proxy')
  mkdirSync(dir, { recursive: true })
  const block = key ? `claude-api-key:\n  - api-key: "${key}"\n    models: []\n` : ''
  writeFileSync(join(dir, 'config.yaml'), `host: "127.0.0.1"\nport: 8317\n${block}`)
  return dir
}

function assistantEnd(cost: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: 'stop',
      usage: { input: 100, output: 20, cacheRead: 300, cacheWrite: 50, cost: { total: cost } },
      ...extra
    }
  })
}

// Paths are baked in: the worker sees only the env allowlist plus the adapter env.
function ompStub(sb: SB, lines: string[], exit: number, stderr = ''): void {
  const out = join(sb.home, 'omp-out.jsonl')
  writeFileSync(out, lines.join('\n') + '\n')
  sb.bin(
    'omp',
    '#!/bin/sh\n' +
      `printf '%s\\n' "$@" > "$HOME/omp-argv"\n` +
      `env > "$HOME/omp-env"\n` +
      `cat > "$HOME/omp-stdin"\n` +
      'echo changed > changed.txt\n' +
      (stderr ? `echo '${stderr}' >&2\n` : '') +
      `cat "${out}"\n` +
      `exit ${exit}\n`
  )
}

function run(sb: SB, dir: string) {
  return sb.fanout(
    [
      'run',
      '--harness',
      'omp',
      '--model',
      'omp/claude-haiku-5-5',
      '--brief',
      sb.brief(BRIEF),
      '--dir',
      sb.repo,
      '--kind',
      'transcribe'
    ],
    { env: { FANOUT_PROXY_DIR: dir } }
  )
}

test('omp runs headless JSON with the Anthropic key from the proxy config', async () => {
  const sb = sandbox().at('2026-11-18T01:00:00Z')
  sb.catalog(`${HEADER}\n${OMP_ROW}\n${FAKE_ROW}\n`)
  ompStub(sb, [assistantEnd(0.001)], 0)
  const r = await run(sb, proxyDir(sb, KEY))
  expect(r.stdout.split('\n')[0]).toMatch(/harness=omp model=claude-haiku-5-5 outcome=ok/)
  const argv = readFileSync(join(sb.home, 'omp-argv'), 'utf8').split('\n')
  for (const a of [
    '-p',
    'json',
    'anthropic/claude-haiku-5-5',
    '--no-session',
    '--no-skills',
    '--no-extensions',
    'yolo'
  ]) {
    expect(argv).toContain(a)
  }
  expect(argv[argv.indexOf('--thinking') + 1]).toBe('medium')
  expect(argv.join(' ')).not.toContain(KEY)
  const env = readFileSync(join(sb.home, 'omp-env'), 'utf8')
  expect(env).toContain(`ANTHROPIC_API_KEY=${KEY}`)
  const agentDir = /PI_CODING_AGENT_DIR=(.*)/.exec(env)?.[1] ?? ''
  expect(readFileSync(join(agentDir, 'config.yml'), 'utf8')).toMatch(/disabledProviders: \[claude, claude-plugins/)
  expect(readFileSync(join(sb.home, 'omp-stdin'), 'utf8')).toContain(BRIEF)
  expect(r.stdout + r.stderr).not.toContain(KEY)
})

test('the job cost is the cost OMP reports, cache writes included', async () => {
  const sb = sandbox().at('2026-11-18T01:00:00Z')
  sb.catalog(`${HEADER}\n${OMP_ROW}\n${FAKE_ROW}\n`)
  ompStub(sb, ['{"type":"session"}', assistantEnd(0.0125), assistantEnd(0.0075), '{"type":"agent_end"}'], 0)
  const r = await run(sb, proxyDir(sb, KEY))
  const [end] = sb.ledger().filter((e) => e.event === 'job_end' && e.harness === 'omp')
  expect(end).toMatchObject({
    outcome: 'ok',
    cost_source: 'reported',
    tokens_in: 300,
    tokens_cached: 600,
    tokens_out: 40
  })
  expect(end.cost_usd as number).toBeCloseTo(0.02, 6)
  expect(r.stdout).toMatch(/COST paid API \(omp\/claude-haiku-5-5\): estimated \$[0-9.]+, actual \$0\.02/)
})

test('a low credit balance is an account-wide credit limit and falls back', async () => {
  const sb = sandbox().at('2026-11-18T01:00:00Z')
  sb.catalog(`${HEADER}\n${OMP_ROW}\n${FAKE_ROW}\n`)
  ompStub(
    sb,
    [],
    1,
    'Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'
  )
  const r = await run(sb, proxyDir(sb, KEY))
  const [end] = sb.ledger().filter((e) => e.event === 'job_end' && e.harness === 'omp')
  expect(end).toMatchObject({ outcome: 'credits_exhausted' })
  const hit = sb.ledger().find((e) => e.event === 'limit_hit')
  expect(hit).toMatchObject({ scope: 'account' })
  expect(r.stdout).toContain('FALLBACK omp/claude-haiku-5-5 credits_exhausted -> fake/f1-a')
})

test('no Anthropic key in the proxy config skips omp without running it', async () => {
  const sb = sandbox().at('2026-11-18T01:00:00Z')
  sb.catalog(`${HEADER}\n${OMP_ROW}\n${FAKE_ROW}\n`)
  ompStub(sb, [assistantEnd(0.001)], 0)
  const r = await run(sb, proxyDir(sb, undefined))
  expect(r.stdout).toMatch(/harness=fake model=f1-a outcome=ok/)
  expect(() => readFileSync(join(sb.home, 'omp-argv'), 'utf8')).toThrow()
})
