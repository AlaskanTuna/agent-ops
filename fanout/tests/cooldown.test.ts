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

const NO_PAID = 'harness,model,status\nfake2,f1-paid,retired\nfake3,f1-paid-b,retired\n'

function hit(ts: string, until: string): Record<string, unknown> {
  return {
    ts,
    event: 'limit_hit',
    harness: 'fake',
    model: 'f1-a',
    scope: 'model',
    outcome: 'rate_limited',
    source: 'backoff',
    until
  }
}

test('backoff doubles across runs', async () => {
  const sb = sandbox()
  sb.catalogPrivate(NO_PAID)
  for (const at of ['2026-11-15T01:00:00Z', '2026-11-15T01:16:00Z', '2026-11-15T01:47:00Z']) {
    sb.at(at)
    sb.script({ 'fake/f1-a': ['rate_limited'] })
    await sb.fanout(RUN(sb))
  }
  const untils = sb
    .ledger()
    .filter((e) => e.event === 'limit_hit')
    .map((e) => e.until)
  expect(untils).toEqual(['2026-11-15T01:15:00.000Z', '2026-11-15T01:46:00.000Z', '2026-11-15T02:47:00.000Z'])
}, 60000)

test('the backoff caps at 4 hours', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  const seeds: Record<string, unknown>[] = []
  for (let i = 0; i < 8; i++) {
    const ts = `2026-11-14T${String(i * 2).padStart(2, '0')}:00:00.000Z`
    const until = new Date(Date.parse(ts) + 15 * 60 * 1000).toISOString()
    seeds.push(hit(ts, until))
  }
  sb.seed(seeds)
  sb.script({ 'fake/f1-a': ['rate_limited'] })
  await sb.fanout(RUN(sb))
  const hits = sb.ledger().filter((e) => e.event === 'limit_hit')
  const last = hits[hits.length - 1]
  expect(last).toMatchObject({ until: '2026-11-15T05:00:00.000Z' })
}, 30000)

test('a burst counts once', async () => {
  const sb = sandbox().at('2026-11-15T01:16:00Z')
  sb.catalogPrivate(NO_PAID)
  const seeds: Record<string, unknown>[] = []
  for (let s = 0; s <= 50; s += 10) {
    seeds.push(hit(`2026-11-15T01:00:${String(s).padStart(2, '0')}.000Z`, '2026-11-15T01:15:00.000Z'))
  }
  sb.seed(seeds)
  sb.script({ 'fake/f1-a': ['rate_limited'] })
  await sb.fanout(RUN(sb))
  const hits = sb.ledger().filter((e) => e.event === 'limit_hit')
  const last = hits[hits.length - 1]
  expect(last).toMatchObject({ until: '2026-11-15T01:46:00.000Z' })
}, 30000)

test('a cooled model is skipped without a fallback line', async () => {
  const sb = sandbox()
  sb.catalogPrivate(NO_PAID)
  sb.at('2026-11-15T01:00:00Z')
  sb.script({ 'fake/f1-a': ['rate_limited'] })
  await sb.fanout(RUN(sb))
  sb.at('2026-11-15T01:05:00Z')
  sb.script({ 'fake/f1-a': ['ok'], 'fake/f1-b': ['ok'] })
  const r = await sb.fanout(RUN(sb))
  expect(r.code).toBe(0)
  const starts = sb.ledger().filter((e) => e.event === 'job_start')
  expect(starts[starts.length - 1]).toMatchObject({ harness: 'fake', model: 'f1-b' })
  expect(r.stdout).not.toContain('FALLBACK')
  expect(sb.ledger().filter((e) => e.event === 'limit_hit').length).toBe(1)
  const p1 = await sb.fanout(['pick', '--all', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'transcribe'])
  expect(p1.stdout).not.toContain('fake/f1-a')
  sb.at('2026-11-15T01:16:00Z')
  const p2 = await sb.fanout(['pick', '--all', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'transcribe'])
  expect(p2.stdout).toContain('fake/f1-a')
}, 60000)

test('account scope skips the whole harness', async () => {
  const sb = sandbox()
  sb.catalogPrivate(NO_PAID)
  sb.at('2026-11-15T01:00:00Z')
  sb.script({ 'fake/f1-a': ['credits_exhausted'] })
  await sb.fanout(RUN(sb))
  sb.at('2026-11-15T01:01:00Z')
  sb.script({ 'fake2/f1-c': ['ok'] })
  const r = await sb.fanout(RUN(sb))
  expect(r.code).toBe(0)
  const starts = sb.ledger().filter((e) => e.event === 'job_start')
  expect(starts[starts.length - 1]).toMatchObject({ harness: 'fake2', model: 'f1-c' })
  const p = await sb.fanout(['pick', '--all', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'transcribe'])
  expect(p.stdout).not.toMatch(/fake\/f1-[ab]/)
}, 60000)

test('a success resets the backoff', async () => {
  const sb = sandbox()
  sb.catalogPrivate(NO_PAID)
  sb.at('2026-11-15T01:00:00Z')
  sb.script({ 'fake/f1-a': ['rate_limited'] })
  await sb.fanout(RUN(sb))
  sb.at('2026-11-15T01:16:00Z')
  sb.script({ 'fake/f1-a': ['ok'] })
  await sb.fanout(RUN(sb))
  sb.at('2026-11-15T01:17:00Z')
  sb.script({ 'fake/f1-a': ['rate_limited'] })
  await sb.fanout(RUN(sb))
  const hits = sb.ledger().filter((e) => e.event === 'limit_hit')
  expect(hits[hits.length - 1]).toMatchObject({ until: '2026-11-15T01:32:00.000Z' })
}, 60000)

test('a stated reset overrides the backoff', async () => {
  const sb = sandbox().at('2026-11-15T01:16:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.seed([hit('2026-11-15T01:00:00.000Z', '2026-11-15T01:15:00.000Z')])
  sb.script({ 'fake/f1-a': ['rate_limited_reset'] })
  await sb.fanout(RUN(sb))
  const hits = sb.ledger().filter((e) => e.event === 'limit_hit')
  expect(hits[hits.length - 1]).toMatchObject({ source: 'stated', until: '2026-11-15T10:00:00.000Z' })
}, 30000)
