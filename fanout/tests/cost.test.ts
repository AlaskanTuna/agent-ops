import { test, expect } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sandbox, waitFor } from './helpers/sandbox'

const BRIEF_TEXT = 'Rename foo in a.txt to bar, nothing else.'
const RUN = (sb: ReturnType<typeof sandbox>) => [
  'run',
  '--brief',
  sb.brief(BRIEF_TEXT),
  '--dir',
  sb.repo,
  '--kind',
  'transcribe'
]

const PAID_PICK = 'harness,model,status\nfake,*,retired\nfake2,f1-c,retired\nfake3,f1-paid-b,retired\n'
const CALL_PICK = 'harness,model,status\nfake,*,retired\nfake2,*,retired\nfake3,f1-paid-b,retired\n'

test('paid job: ESTIMATE on stderr while the worker runs; COST has estimate and actual', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(PAID_PICK)
  sb.script({ 'fake2/f1-paid': ['ok_slow'] })
  sb.env.FAKE_SLEEP_S = '2'
  const p = sb.start(RUN(sb))
  await waitFor(() => p.stderrSoFar().includes('ESTIMATE paid API (fake2/f1-paid): $0.14'), 5000)
  expect(readdirSync(join(sb.home, 'run')).some((f) => f.endsWith('.lease'))).toBe(true)
  const r = await p.done()
  expect(r.stdout).toMatch(
    /^COST paid API \(fake2\/f1-paid\): estimated \$0\.14, actual \$0\.0014 \(computed from tokens\)\. Tell the user, then run: fanout ack \w{26}$/m
  )
}, 30000)

test('no usage: actual unknown', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(PAID_PICK)
  sb.script({ 'fake2/f1-paid': ['ok_no_usage'] })
  const r = await sb.fanout(RUN(sb))
  expect(r.code).toBe(0)
  expect(r.stdout).toMatch(/estimated \$0\.14, actual unknown/)
  const end = sb.ledger().find((e) => e.event === 'job_end')
  expect(end).toMatchObject({ cost_source: 'unknown' })
  expect(end?.cost_usd).toBeUndefined()
}, 30000)

test('subscription and free jobs print no COST line', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  const r = await sb.fanout(RUN(sb))
  expect(r.code).toBe(0)
  expect(r.stdout).not.toContain('COST')
  expect(r.stderr).not.toContain('ESTIMATE')
}, 30000)

test('a fallback onto a paid row prints FALLBACK and COST', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.script({ 'fake/f1-a': ['rate_limited'], 'fake/f1-b': ['rate_limited'], 'fake2/f1-c': ['rate_limited'] })
  const r = await sb.fanout(RUN(sb))
  expect(r.code).toBe(0)
  const lines = r.stdout.split('\n')
  expect(lines[0]).toMatch(/^FANOUT job=\w{26} harness=fake3 model=f1-paid-b outcome=ok attempt=4$/)
  expect(lines.filter((l) => l.startsWith('FALLBACK')).length).toBe(3)
  expect(r.stdout).toMatch(
    /^COST paid API \(fake3\/f1-paid-b\): estimated \$0\.07, actual \$0\.0007 \(computed from tokens\)/m
  )
}, 30000)

test('per-call counted from the proxy log', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(CALL_PICK)
  sb.script({ 'fake3/f1-call': ['ok'] })
  sb.env.FAKE_PROXY_BACKED = 'fake3'
  sb.env.FAKE_CALLS = '6'
  const r = await sb.fanout(['run', '--brief', sb.brief(BRIEF_TEXT, 7000), '--dir', sb.repo, '--kind', 'transcribe'])
  expect(r.code).toBe(0)
  expect(r.stderr).toContain('ESTIMATE per-call (fake3/f1-call): 16 MC (8 turns x 2 MC, upper-bound guess)')
  expect(r.stdout).toMatch(
    /^COST per-call \(fake3\/f1-call\): estimated 16 MC \(8 turns x 2 MC, upper-bound guess\), actual 6 calls = 12 MC \(counted from proxy log\)\. Tell the user, then run: fanout ack \w{26}$/m
  )
}, 30000)

test('per-call without FAKE_CALLS is unmeasured', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(CALL_PICK)
  sb.script({ 'fake3/f1-call': ['ok'] })
  sb.env.FAKE_PROXY_BACKED = 'fake3'
  const r = await sb.fanout(['run', '--brief', sb.brief(BRIEF_TEXT, 7000), '--dir', sb.repo, '--kind', 'transcribe'])
  expect(r.code).toBe(0)
  expect(r.stdout).toMatch(/actual unmeasured/)
}, 30000)

test('two overlapping per-call runs are both unmeasured', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(CALL_PICK)
  sb.script({ 'fake3/f1-call': ['ok_slow'] })
  sb.env.FAKE_PROXY_BACKED = 'fake3'
  sb.env.FAKE_CALLS = '6'
  sb.env.FAKE_SLEEP_S = '2'
  const args = ['run', '--brief', sb.brief(BRIEF_TEXT, 7000), '--dir', sb.repo, '--kind', 'transcribe']
  const p1 = sb.start(args)
  const p2 = sb.start(args)
  const [r1, r2] = await Promise.all([p1.done(), p2.done()])
  expect(r1.code).toBe(0)
  expect(r2.code).toBe(0)
  expect(r1.stdout).toMatch(/actual unmeasured/)
  expect(r2.stdout).toMatch(/actual unmeasured/)
}, 30000)

test('the ledger carries the numbers', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(PAID_PICK)
  sb.script({ 'fake2/f1-paid': ['ok'] })
  const r = await sb.fanout(RUN(sb))
  expect(r.code).toBe(0)
  const [start, end] = sb.ledger()
  expect(start).toMatchObject({ event: 'job_start', cost_est_usd: 0.14 })
  expect(end).toMatchObject({ event: 'job_end', cost_usd: 0.0014, cost_source: 'computed' })
  const sb2 = sandbox().at('2026-11-15T01:00:00Z')
  sb2.catalogPrivate(CALL_PICK)
  sb2.script({ 'fake3/f1-call': ['ok'] })
  sb2.env.FAKE_PROXY_BACKED = 'fake3'
  sb2.env.FAKE_CALLS = '6'
  const r2 = await sb2.fanout([
    'run',
    '--brief',
    sb2.brief(BRIEF_TEXT, 7000),
    '--dir',
    sb2.repo,
    '--kind',
    'transcribe'
  ])
  expect(r2.code).toBe(0)
  const [cstart, cend] = sb2.ledger()
  expect(cstart).toMatchObject({ event: 'job_start', cost_est_mc: 16, calls_est: 8 })
  expect(cend).toMatchObject({ event: 'job_end', cost_mc: 12, calls: 6 })
  for (const e of [...sb.ledger(), ...sb2.ledger()]) {
    expect(e.cost_source === undefined || e.cost_source === 'computed' || e.cost_source === 'unknown').toBe(true)
  }
}, 30000)

test('an interrupted paid job still prints a COST line', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(PAID_PICK)
  sb.script({ 'fake2/f1-paid': ['usage_then_sleep'] })
  sb.env.FAKE_SLEEP_S = '30'
  const p = sb.start(RUN(sb))
  await waitFor(() => readdirSync(join(sb.home, 'run')).some((f) => f.endsWith('.lease')), 5000)
  await waitFor(
    () =>
      existsSync(join(sb.home, 'logs')) &&
      readdirSync(join(sb.home, 'logs')).some(
        (f) => f.endsWith('.log') && readFileSync(join(sb.home, 'logs', f), 'utf8').includes('USAGE')
      ),
    5000
  )
  process.kill(p.pid, 'SIGTERM')
  const r = await p.done()
  expect(r.code).toBe(143)
  expect(r.stdout).toMatch(
    /^COST paid API \(fake2\/f1-paid\): estimated \$0\.14, actual \$0\.0014 \(computed from the worker log\)\. Tell the user, then run: fanout ack \w{26}$/m
  )
}, 30000)
