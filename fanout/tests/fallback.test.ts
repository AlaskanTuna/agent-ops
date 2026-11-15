import { test, expect } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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

test('rate_limited_reset falls back, states the reset, tells the caller to ack', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['rate_limited_reset'] })
  const r = await sb.fanout(RUN(sb))
  const l = r.stdout.split('\n')
  expect(r.code).toBe(0)
  expect(l[0]).toMatch(/^FANOUT job=\w{26} harness=fake model=f1-b outcome=ok attempt=2$/)
  expect(l[1]).toMatch(
    /^FALLBACK fake\/f1-a rate_limited \(resets 18:00\) -> fake\/f1-b\. Tell the user, then run: fanout ack \w{26}$/
  )
  const [s1, s2] = sb.ledger().filter((e) => e.event === 'job_start')
  expect(s2).toMatchObject({ attempt: 2, reason: 'fallback', from_job: s1.job, root: s1.root })
}, 30000)

test('tier 1 exhausted climbs to tier 2', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['rate_limited'], 'fake/f1-b': ['rate_limited'], 'fake2/f1-c': ['rate_limited'] })
  const r = await sb.fanout(RUN(sb))
  const l = r.stdout.split('\n')
  expect(r.code).toBe(0)
  expect(l[0]).toMatch(/^FANOUT job=\w{26} harness=fake model=f2-a outcome=ok attempt=4$/)
  const fallbacks = l.filter((x) => x.startsWith('FALLBACK'))
  expect(fallbacks.length).toBe(3)
  expect(r.stdout).not.toContain('(resets')
  expect(fallbacks[0]).toMatch(/^FALLBACK fake\/f1-a rate_limited -> fake\/f1-b\./)
  expect(fallbacks[2]).toMatch(/^FALLBACK fake2\/f1-c rate_limited -> fake\/f2-a\./)
}, 30000)

test('starting at tier 2 never touches tier 1', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f2-a': ['rate_limited'] })
  const r = await sb.fanout([...RUN(sb), '--kind', 'edit'])
  expect(r.code).toBe(0)
  expect(r.stdout.split('\n')[0]).toMatch(/model=f2-b .*attempt=2/)
  expect(sb.ledger().filter((e) => e.event === 'job_start' && e.tier === 1).length).toBe(0)
}, 30000)

test('all candidates exhausted', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.script({ 'fake/f3-z': ['quota_exhausted'], 'fake3/f3-a': ['quota_exhausted'] })
  const r = await sb.fanout([...RUN(sb), '--tier', '3'])
  expect(r.code).toBe(1)
  expect(r.stdout).toContain(
    'FAILED all candidates exhausted. Tried: fake/f3-z (quota_exhausted), fake3/f3-a (quota_exhausted)'
  )
  expect(r.stdout.split('\n')[0]).toMatch(/outcome=quota_exhausted attempt=2/)
}, 30000)

test('each attempt gets a fresh worktree', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['writes_then_limit'] })
  const r = await sb.fanout(RUN(sb))
  expect(r.code).toBe(0)
  const patchLine = r.stdout.split('\n').find((l) => l.startsWith('PATCH='))
  const patch = readFileSync(patchLine!.slice('PATCH='.length), 'utf8')
  expect(patch).not.toContain('partial.txt')
  const dirs = readdirSync(join(sb.home, 'worktrees')).filter((f) => !f.endsWith('.fanout-repo'))
  expect(dirs.filter((d) => d.endsWith('-a1')).length).toBe(1)
  expect(dirs.filter((d) => d.endsWith('-a2')).length).toBe(1)
  const a1 = dirs.find((d) => d.endsWith('-a1'))!
  expect(existsSync(join(sb.home, 'worktrees', a1, 'partial.txt'))).toBe(true)
}, 30000)

test('a non-git directory stops after a dirty attempt', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  const plain = join(sb.home, 'plain')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(plain, { recursive: true })
  sb.script({ 'fake/f1-a': ['writes_then_limit'] })
  const r = await sb.fanout(['run', '--brief', sb.brief(), '--dir', plain, '--kind', 'transcribe'])
  expect(r.code).toBe(1)
  expect(r.stdout).toContain('NOTE attempt 1 changed files outside git; not retrying')
  expect(sb.ledger().filter((e) => e.event === 'job_start').length).toBe(1)
}, 30000)

test('a non-git directory falls back after a clean attempt', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  const plain = join(sb.home, 'plain')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(plain, { recursive: true })
  sb.script({ 'fake/f1-a': ['rate_limited'] })
  const r = await sb.fanout(['run', '--brief', sb.brief(), '--dir', plain, '--kind', 'transcribe'])
  expect(r.code).toBe(0)
  expect(sb.ledger().filter((e) => e.event === 'job_start').length).toBe(2)
  expect(r.stdout.split('\n')[0]).toMatch(/outcome=ok attempt=2/)
}, 30000)

test('a missing CLI skips its whole harness once', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake2/f1-c': ['ok'] })
  const r = await sb.fanout(RUN(sb), { env: { FAKE_MISSING: 'fake' } })
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('NOTE fake: CLI missing')
  const starts = sb.ledger().filter((e) => e.event === 'job_start')
  expect(starts[0]).toMatchObject({ harness: 'fake2', model: 'f1-c' })
  const hits = sb.ledger().filter((e) => e.event === 'limit_hit')
  expect(hits.length).toBe(1)
  expect(hits[0]).toMatchObject({ harness: 'fake', scope: 'account', outcome: 'worker_error', source: 'backoff' })
}, 30000)

test('a detached chain reports its fallback through wait', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['rate_limited_reset'] })
  const d = await sb.fanout([...RUN(sb), '--detach'])
  expect(d.code).toBe(0)
  const id = d.stdout.trim().split('\n')[0].slice('JOB '.length)
  const r = await sb.fanout(['wait', id])
  expect(r.code).toBe(0)
  expect(r.stdout).toMatch(/^FALLBACK fake\/f1-a rate_limited \(resets 18:00\) -> fake\/f1-b\./m)
}, 30000)
