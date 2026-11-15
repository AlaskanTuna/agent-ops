import { test, expect } from 'bun:test'
import { sandbox } from './helpers/sandbox'

const RUN = (sb: ReturnType<typeof sandbox>) => [
  'run',
  '--brief',
  sb.brief('Rename foo in a.txt to bar, nothing else.'),
  '--dir',
  sb.repo,
  '--kind',
  'transcribe'
]

test('a limit with a stated clock reset is recorded as stated', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.script({ 'fake/f1-a': ['rate_limited_reset'] })
  await sb.fanout(RUN(sb))
  const end = sb.ledger().find((e) => e.event === 'job_end')
  const hit = sb.ledger().find((e) => e.event === 'limit_hit')
  expect(end).toMatchObject({ outcome: 'rate_limited', pattern: 'gen-429' })
  expect(hit).toMatchObject({
    harness: 'fake',
    model: 'f1-a',
    scope: 'model',
    outcome: 'rate_limited',
    source: 'stated',
    until: '2026-11-15T10:00:00.000Z'
  })
}, 30000)

test('rate_limited without a time backs off 15 minutes', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.script({ 'fake/f1-a': ['rate_limited'] })
  await sb.fanout(RUN(sb))
  const hit = sb.ledger().find((e) => e.event === 'limit_hit')
  expect(hit).toMatchObject({ source: 'backoff', until: '2026-11-15T01:15:00.000Z' })
}, 30000)

test('quota_exhausted states a relative reset', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.script({ 'fake/f1-a': ['quota_exhausted'] })
  await sb.fanout(RUN(sb))
  const end = sb.ledger().find((e) => e.event === 'job_end')
  const hit = sb.ledger().find((e) => e.event === 'limit_hit')
  expect(end).toMatchObject({ outcome: 'quota_exhausted', pattern: 'gen-quota' })
  expect(hit).toMatchObject({ source: 'stated', until: '2026-11-15T03:00:00.000Z' })
}, 30000)

test('credits and auth are account scope; model errors are model scope', async () => {
  for (const [scenario, pattern, scope] of [
    ['credits_exhausted', 'gen-credits', 'account'],
    ['auth_error', 'gen-auth', 'account'],
    ['model_unavailable', 'gen-model', 'model']
  ] as const) {
    const sb = sandbox().at('2026-11-15T01:00:00Z')
    sb.script({ 'fake/f1-a': [scenario] })
    await sb.fanout(RUN(sb))
    const end = sb.ledger().find((e) => e.event === 'job_end')
    const hit = sb.ledger().find((e) => e.event === 'limit_hit')
    expect(end).toMatchObject({ outcome: scenario, pattern })
    expect(hit).toMatchObject({ scope })
  }
}, 60000)

test('a repeated unknown records a backoff limit', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.script({ 'fake/f1-a': ['unknown_error'] })
  await sb.fanout(RUN(sb))
  const ends = sb.ledger().filter((e) => e.event === 'job_end')
  expect(ends[0]).toMatchObject({ outcome: 'unknown' })
  expect(ends[0] && 'pattern' in ends[0] && ends[0].pattern).toBeFalsy()
  expect(sb.ledger().find((e) => e.event === 'limit_hit')).toMatchObject({ source: 'backoff' })
}, 30000)

test('exit 0 that mentions 429 stays ok', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.script({ 'fake/f1-a': ['ok_mentions_429'] })
  await sb.fanout(RUN(sb))
  const end = sb.ledger().find((e) => e.event === 'job_end')
  expect(end).toMatchObject({ outcome: 'ok' })
  expect(sb.ledger().find((e) => e.event === 'limit_hit')).toBeUndefined()
}, 30000)

test('stdout is scanned too', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.script({ 'fake/f1-a': ['stdout_limit'] })
  await sb.fanout(RUN(sb))
  const end = sb.ledger().find((e) => e.event === 'job_end')
  expect(end).toMatchObject({ outcome: 'rate_limited' })
}, 30000)

test('adapter rules rank before generic rules', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.script({ 'fake/f1-a': ['custom_error'] })
  await sb.fanout(RUN(sb), { env: { FAKE_STDERR: 'HTTP 429 special-quota' } })
  const end = sb.ledger().find((e) => e.event === 'job_end')
  expect(end).toMatchObject({ outcome: 'quota_exhausted', pattern: 'fake-special' })
}, 30000)

test('an onExit0 rule applies to a clean exit', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.script({ 'fake/f1-a': ['ok_hidden_failure'] })
  await sb.fanout(RUN(sb))
  const end = sb.ledger().find((e) => e.event === 'job_end')
  expect(end).toMatchObject({ outcome: 'worker_error', pattern: 'fake-hidden', exit: 0 })
}, 30000)

test('overload backs off 30 seconds', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.script({ 'fake/f1-a': ['custom_error'] })
  await sb.fanout(RUN(sb), { env: { FAKE_STDERR: 'model overloaded' } })
  const end = sb.ledger().find((e) => e.event === 'job_end')
  const hit = sb.ledger().find((e) => e.event === 'limit_hit')
  expect(end).toMatchObject({ pattern: 'gen-overload' })
  expect(hit).toMatchObject({ source: 'backoff', until: '2026-11-15T01:00:30.000Z' })
}, 30000)

test('reset phrases', async () => {
  const cases: [string, string][] = [
    ['HTTP 429 retry-after: 120', '2026-11-15T01:02:00.000Z'],
    ['HTTP 429 try again in 2 hours 5 minutes', '2026-11-15T03:05:00.000Z'],
    ['HTTP 429 resets in 3h 20m', '2026-11-15T04:20:00.000Z'],
    ['HTTP 429 resets at 18:00', '2026-11-15T10:00:00.000Z'],
    ['HTTP 429 resets 6:00 PM', '2026-11-15T10:00:00.000Z'],
    ['HTTP 429 resets 2026-11-16T03:00:00Z', '2026-11-16T03:00:00.000Z']
  ]
  for (const [stderr, until] of cases) {
    const sb = sandbox().at('2026-11-15T01:00:00Z')
    sb.script({ 'fake/f1-a': ['custom_error'] })
    await sb.fanout(RUN(sb), { env: { FAKE_STDERR: stderr } })
    const hit = sb.ledger().find((e) => e.event === 'limit_hit')
    expect(hit).toMatchObject({ source: 'stated', until })
  }
  const sb = sandbox().at('2026-11-15T12:00:00Z')
  sb.script({ 'fake/f1-a': ['custom_error'] })
  await sb.fanout(RUN(sb), { env: { FAKE_STDERR: 'HTTP 429 resets at 18:00' } })
  const hit = sb.ledger().find((e) => e.event === 'limit_hit')
  expect(hit).toMatchObject({ source: 'stated', until: '2026-11-16T10:00:00.000Z' })
}, 60000)
