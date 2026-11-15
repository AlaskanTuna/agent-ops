import { test, expect } from 'bun:test'
import { sandbox } from './helpers/sandbox'

const NO_PAID = 'harness,model,status\nfake2,f1-paid,retired\nfake3,f1-paid-b,retired\n'

function runArgs(sb: ReturnType<typeof sandbox>, extra: string[] = []) {
  return [
    'run',
    '--brief',
    sb.brief('Rename foo in a.txt to bar, nothing else.'),
    '--dir',
    sb.repo,
    '--kind',
    'transcribe',
    ...extra
  ]
}

test('--model starts on that row', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-b': ['ok'] })
  const r = await sb.fanout(runArgs(sb, ['--model', 'f1-b']))
  expect(r.code).toBe(0)
  expect(r.stdout.split('\n')[0]).toMatch(/harness=fake model=f1-b outcome=ok attempt=1/)
  expect(r.stdout).not.toContain('FALLBACK')
}, 30000)

test('a limit on the starting model is a reported fallback', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-b': ['rate_limited'] })
  const r = await sb.fanout(runArgs(sb, ['--model', 'f1-b']))
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('FALLBACK fake/f1-b rate_limited -> fake2/f1-c.')
  expect(r.stdout.split('\n')[0]).toMatch(/model=f1-c outcome=ok attempt=2/)
}, 30000)

test('--pin ends the chain on the first limit', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['rate_limited'] })
  const r = await sb.fanout(runArgs(sb, ['--pin']))
  expect(r.code).toBe(1)
  expect(r.stdout).toContain('FAILED all candidates exhausted. Tried: fake/f1-a (rate_limited)')
  expect(sb.ledger().filter((e) => e.event === 'job_start')).toHaveLength(1)
}, 30000)

test('--pin still retries an unknown error once', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['unknown_error', 'ok'] })
  const r = await sb.fanout(runArgs(sb, ['--pin']))
  expect(r.code).toBe(0)
  expect(r.stdout.split('\n')[0]).toMatch(/attempt=2/)
  expect(r.stdout).toContain('RETRY')
}, 30000)

test('--expect names a cooling model: a pre-start reroute is reported', async () => {
  const sb = sandbox().at('2026-11-15T01:05:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.seed([
    {
      ts: '2026-11-15T01:00:00.000Z',
      event: 'limit_hit',
      harness: 'fake',
      model: 'f1-a',
      scope: 'model',
      outcome: 'rate_limited',
      source: 'backoff',
      until: '2026-11-15T01:15:00.000Z'
    }
  ])
  sb.script({ 'fake/f1-b': ['ok'] })
  const r = await sb.fanout(runArgs(sb, ['--expect', 'fake/f1-a']))
  expect(r.code).toBe(0)
  expect(r.stdout.split('\n')[0]).toMatch(/model=f1-b outcome=ok attempt=1/)
  expect(r.stdout.split('\n')[1]).toMatch(
    /^FALLBACK fake\/f1-a not started \(cooling down until 09:15, rate_limited\) -> fake\/f1-b\. Tell the user, then run: fanout ack \w{26}$/
  )
  const starts = sb.ledger().filter((e) => e.event === 'job_start')
  expect(starts[0]).toMatchObject({ expected: 'fake/f1-a' })
}, 30000)

test('--expect on an available model prints nothing extra', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['ok'] })
  const r = await sb.fanout(runArgs(sb, ['--expect', 'fake/f1-a']))
  expect(r.code).toBe(0)
  expect(r.stdout).not.toContain('FALLBACK')
  expect(sb.ledger().filter((e) => e.event === 'job_start')[0]).toMatchObject({ expected: 'fake/f1-a' })
}, 30000)

test('--expect on a retired row', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate('harness,model,status\nfake,f1-a,retired\n')
  sb.script({ 'fake/f1-b': ['ok'] })
  const r = await sb.fanout(runArgs(sb, ['--expect', 'fake/f1-a']))
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('FALLBACK fake/f1-a not started (retired) -> fake/f1-b.')
}, 30000)

test('--expect on a model that is not in the catalog', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['ok'] })
  const r = await sb.fanout(runArgs(sb, ['--expect', 'fake/nope']))
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('FALLBACK fake/nope not started (not in the catalog) -> fake/f1-a.')
}, 30000)

test('a private chunk may not be sent to a public-only row by name', async () => {
  for (const extra of [
    ['--model', 'f1-pub'],
    ['--pin', '--model', 'f1-pub']
  ]) {
    const sb = sandbox().at('2026-11-15T01:00:00Z')
    sb.catalogPrivate(NO_PAID)
    const r = await sb.fanout(runArgs(sb, extra))
    expect(r.code).toBe(3)
    expect(r.stdout).toContain('REFUSED fake3/f1-pub is public-only and this chunk is private')
    expect(sb.ledger()).toEqual([])
  }
}, 60000)

test('--public lets the public-only row run', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake3/f1-pub': ['ok'] })
  const r = await sb.fanout(runArgs(sb, ['--public', '--model', 'f1-pub']))
  expect(r.code).toBe(0)
  expect(r.stdout.split('\n')[0]).toMatch(/harness=fake3 model=f1-pub/)
}, 30000)

test('an unknown model exits 2', async () => {
  const sb = sandbox()
  const r = await sb.fanout(runArgs(sb, ['--model', 'nope']))
  expect(r.code).toBe(2)
  expect(r.stderr).toContain('unknown model nope')
}, 30000)

test('an unproven explicit model runs with a note, and a fallback skips unproven rows', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake3/f1-trial': ['rate_limited'] })
  const r = await sb.fanout(runArgs(sb, ['--model', 'f1-trial']))
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('NOTE model fake3/f1-trial has no proof of compatibility yet')
  expect(r.stdout).toContain('FALLBACK fake3/f1-trial rate_limited -> fake/f1-a.')
}, 30000)

test('pick --model shows the start', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  const r = await sb.fanout([
    'pick',
    '--brief',
    sb.brief(),
    '--dir',
    sb.repo,
    '--kind',
    'transcribe',
    '--model',
    'f2-a'
  ])
  expect(r.code).toBe(0)
  expect(r.stdout.split('\n')[0]).toMatch(/^PICK harness=fake model=f2-a tier=2/)
}, 30000)
