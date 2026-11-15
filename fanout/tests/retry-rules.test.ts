import { test, expect } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sandbox, waitFor } from './helpers/sandbox'

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

test('unknown is retried once on the same model', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['unknown_error', 'ok'] })
  const r = await sb.fanout(runArgs(sb))
  expect(r.code).toBe(0)
  expect(r.stdout.split('\n')[0]).toMatch(/model=f1-a outcome=ok attempt=2/)
  expect(r.stdout).toContain('RETRY fake/f1-a unknown; retried once on the same model')
  expect(r.stdout).not.toContain('FALLBACK')
  expect(sb.ledger().find((e) => e.event === 'limit_hit')).toBeUndefined()
  const starts = sb.ledger().filter((e) => e.event === 'job_start')
  expect(starts).toHaveLength(2)
  expect(starts[1]).toMatchObject({ reason: 'retry', from_job: starts[0].job })
}, 30000)

test('unknown twice backs off and falls back', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['unknown_error', 'unknown_error'] })
  const r = await sb.fanout(runArgs(sb))
  expect(r.code).toBe(0)
  const hits = sb.ledger().filter((e) => e.event === 'limit_hit')
  expect(hits).toHaveLength(1)
  expect(hits[0]).toMatchObject({ source: 'backoff', until: '2026-11-15T01:15:00.000Z' })
  expect(r.stdout).toContain('FALLBACK fake/f1-a unknown -> fake/f1-b.')
  expect(r.stdout.split('\n')[0]).toMatch(/model=f1-b outcome=ok attempt=3/)
}, 30000)

test('worker_error is not retried', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['worker_crash'] })
  const r = await sb.fanout(runArgs(sb))
  expect(r.code).toBe(0)
  const starts = sb.ledger().filter((e) => e.event === 'job_start' && e.model === 'f1-a')
  expect(starts).toHaveLength(1)
  const hits = sb.ledger().filter((e) => e.event === 'limit_hit')
  expect(hits).toHaveLength(1)
  expect(hits[0]).toMatchObject({ source: 'backoff' })
  expect(r.stdout).toContain('FALLBACK fake/f1-a worker_error -> fake/f1-b.')
}, 30000)

test('a timeout falls back without a cooldown', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['timeout'] })
  const pidfile = join(sb.home, 'pids')
  const r = await sb.fanout(runArgs(sb, ['--timeout', '1']), { env: { FAKE_PIDFILE: pidfile } })
  expect(r.code).toBe(0)
  expect(sb.ledger().find((e) => e.event === 'limit_hit')).toBeUndefined()
  expect(r.stdout).toContain('FALLBACK fake/f1-a timeout -> fake/f1-b.')
  expect(existsSync(pidfile)).toBe(true)
  const pids = readFileSync(pidfile, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  expect(pids.length).toBeGreaterThan(0)
  for (const pid of pids) {
    await waitFor(() => !existsSync(`/proc/${pid}`))
  }
}, 60000)

test('a second timeout stops the chain', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['timeout'], 'fake/f1-b': ['timeout'] })
  const r = await sb.fanout(runArgs(sb, ['--timeout', '1']))
  expect(r.code).toBe(1)
  expect(r.stdout).toContain('NOTE timed out twice; split the chunk or raise --timeout')
  expect(r.stdout).toContain('FAILED timed out twice. Tried: fake/f1-a (timeout), fake/f1-b (timeout)')
  expect(sb.ledger().filter((e) => e.event === 'job_start')).toHaveLength(2)
}, 60000)

test('--max-attempts caps the chain', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['rate_limited'], 'fake/f1-b': ['rate_limited'] })
  const r = await sb.fanout(runArgs(sb, ['--max-attempts', '2']))
  expect(r.code).toBe(1)
  expect(r.stdout).toContain(
    'FAILED stopped after 2 attempts. Tried: fake/f1-a (rate_limited), fake/f1-b (rate_limited)'
  )
  expect(sb.ledger().filter((e) => e.event === 'job_start')).toHaveLength(2)
}, 30000)

test('a bad --max-attempts is a usage error', async () => {
  const sb = sandbox()
  const r = await sb.fanout(runArgs(sb, ['--max-attempts', '0']))
  expect(r.code).toBe(2)
  expect(r.stderr).toContain('--max-attempts must be 1 or more')
}, 30000)
