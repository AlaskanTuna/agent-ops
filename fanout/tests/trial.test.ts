import { test, expect } from 'bun:test'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sandbox } from './helpers/sandbox'

const NO_PAID = 'harness,model,status\nfake2,f1-paid,retired\nfake3,f1-paid-b,retired\n'
const TIER3 = `${NO_PAID}fake,f3-z,retired\n`

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

test('a half-open success clears the cooldown', async () => {
  const sb = sandbox().at('2026-11-15T01:16:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.seed([hit('2026-11-15T01:00:00.000Z', '2026-11-15T01:15:00.000Z')])
  sb.script({ 'fake/f1-a': ['ok'] })
  const r = await sb.fanout(runArgs(sb))
  expect(r.code).toBe(0)
  expect(r.stdout.split('\n')[0]).toMatch(/model=f1-a outcome=ok attempt=1/)
  expect(sb.ledger().find((e) => e.event === 'trial')).toMatchObject({ harness: 'fake', model: 'f1-a' })
  const runDir = join(sb.home, 'run')
  const locks = existsSync(runDir) ? readdirSync(runDir).filter((f) => f.startsWith('trial-')) : []
  expect(locks).toEqual([])
  sb.at('2026-11-15T01:17:00Z')
  sb.script({ 'fake/f1-a': ['rate_limited'] })
  await sb.fanout(runArgs(sb))
  const hits = sb.ledger().filter((e) => e.event === 'limit_hit')
  expect(hits[hits.length - 1]).toMatchObject({ until: '2026-11-15T01:32:00.000Z' })
}, 60000)

test('a half-open failure re-arms with double the backoff', async () => {
  const sb = sandbox().at('2026-11-15T01:16:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.seed([hit('2026-11-15T01:00:00.000Z', '2026-11-15T01:15:00.000Z')])
  sb.script({ 'fake/f1-a': ['rate_limited'] })
  const r = await sb.fanout(runArgs(sb))
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('FALLBACK fake/f1-a rate_limited -> fake/f1-b.')
  const hits = sb.ledger().filter((e) => e.event === 'limit_hit')
  expect(hits[hits.length - 1]).toMatchObject({ until: '2026-11-15T01:46:00.000Z' })
  const runDir = join(sb.home, 'run')
  const locks = existsSync(runDir) ? readdirSync(runDir).filter((f) => f.startsWith('trial-')) : []
  expect(locks).toEqual([])
}, 30000)

test('six concurrent runs on an expired cooldown: exactly one takes the trial', async () => {
  const sb = sandbox().at('2026-11-15T01:20:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.seed([hit('2026-11-15T01:00:00.000Z', '2026-11-15T01:15:00.000Z')])
  sb.script({ 'fake/f1-a': ['ok_slow'] })
  const handles = Array.from({ length: 6 }, () => sb.start(runArgs(sb), { env: { FAKE_SLEEP_S: '1' } }))
  const results = await Promise.all(handles.map((h) => h.done()))
  expect(results.map((r) => r.code)).toEqual([0, 0, 0, 0, 0, 0])
  const starts = sb.ledger().filter((e) => e.event === 'job_start')
  expect(starts.filter((s) => s.model === 'f1-a')).toHaveLength(1)
  expect(starts.filter((s) => s.model === 'f1-b')).toHaveLength(5)
}, 60000)

test('a stale trial lock is taken over', async () => {
  const sb = sandbox().at('2026-11-15T01:16:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.seed([hit('2026-11-15T01:00:00.000Z', '2026-11-15T01:15:00.000Z')])
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(sb.home, 'run'), { recursive: true })
  writeFileSync(join(sb.home, 'run', 'trial-fake%2Ff1-a.lock'), JSON.stringify({ pid: 999999999, startTicks: 1 }))
  sb.script({ 'fake/f1-a': ['ok'] })
  const r = await sb.fanout(runArgs(sb))
  expect(r.code).toBe(0)
  expect(r.stdout.split('\n')[0]).toMatch(/model=f1-a outcome=ok/)
}, 30000)

test('wait under 30 minutes, then the trial succeeds', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(TIER3)
  sb.script({ 'fake3/f3-a': ['rate_limited_soon', 'ok'] })
  const r = await sb.fanout(runArgs(sb, ['--tier', '3']))
  expect(r.code).toBe(0)
  expect(r.stderr).toContain('WAIT 600s until 09:10')
  expect(r.stdout.split('\n')[0]).toMatch(/harness=fake3 model=f3-a outcome=ok attempt=2/)
  expect(r.stdout).toContain('NOTE waited 600s for fake3/f3-a to reset (09:10)')
  const starts = sb.ledger().filter((e) => e.event === 'job_start')
  expect(starts).toHaveLength(2)
  expect(starts[1]).toMatchObject({ ts: '2026-11-15T01:10:00.000Z', reason: 'fallback' })
}, 30000)

test('a reset over 30 minutes is not waited for', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(TIER3)
  sb.script({ 'fake3/f3-a': ['quota_exhausted'] })
  const r = await sb.fanout(runArgs(sb, ['--tier', '3']))
  expect(r.code).toBe(1)
  expect(r.stdout).toContain('FAILED all candidates exhausted. Tried: fake3/f3-a (quota_exhausted)')
  expect(r.stderr).not.toContain('WAIT')
}, 30000)

test('a backoff cooldown is never waited for', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(TIER3)
  sb.script({ 'fake3/f3-a': ['rate_limited'] })
  const r = await sb.fanout(runArgs(sb, ['--tier', '3']))
  expect(r.code).toBe(1)
  expect(r.stdout).toContain('FAILED')
  expect(r.stderr).not.toContain('WAIT')
}, 30000)

test('a run waits at most once', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(TIER3)
  sb.script({ 'fake3/f3-a': ['rate_limited_soon', 'rate_limited_soon'] })
  const r = await sb.fanout(runArgs(sb, ['--tier', '3']))
  expect(r.code).toBe(1)
  expect(r.stderr.split('\n').filter((l) => l.startsWith('WAIT'))).toHaveLength(1)
}, 30000)
