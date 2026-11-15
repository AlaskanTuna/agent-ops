import { test, expect } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sandbox, waitFor } from './helpers/sandbox'

const BASE = '2026-11-15T01:00:00Z'

function statusJson(sb: ReturnType<typeof sandbox>, patch: Record<string, unknown>): void {
  writeFileSync(
    join(sb.home, 'status.json'),
    JSON.stringify({
      generated_at: '2026-11-14T00:00:00.000Z',
      last_upkeep_attempt: '2026-11-14T00:00:00.000Z',
      last_upkeep_ok: '2026-11-14T00:00:00.000Z',
      ...patch
    })
  )
}

function readStatus(sb: ReturnType<typeof sandbox>): Record<string, unknown> {
  return JSON.parse(readFileSync(join(sb.home, 'status.json'), 'utf8')) as Record<string, unknown>
}

function upkeepEvents(sb: ReturnType<typeof sandbox>): Record<string, unknown>[] {
  return sb.ledger().filter((e) => e.event === 'upkeep')
}

test('a failing step is recorded and the next one still runs', async () => {
  const sb = sandbox().at(BASE)
  const r = await sb.fanout(['upkeep'], { env: { FANOUT_TEST_STEPS: 'fail,ok' } })
  expect(r.code).toBe(0)
  const events = upkeepEvents(sb)
  expect(events).toHaveLength(2)
  expect(events.map((e) => e.step).sort()).toEqual(['fail', 'ok'])
  expect(events.find((e) => e.step === 'fail')).toMatchObject({ status: 'failed', detail: 'boom' })
  expect(events.find((e) => e.step === 'ok')).toMatchObject({ status: 'ok' })
  const st = readStatus(sb)
  for (const e of events) {
    expect(String(st.generated_at) > String(e.ts)).toBe(true)
  }
}, 30000)

test('last_upkeep_ok only moves on a clean run', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  await sb.fanout(['upkeep'], { env: { FANOUT_TEST_STEPS: 'ok' } })
  expect(readStatus(sb).last_upkeep_ok).toBe('2026-11-15T01:00:00.000Z')
  sb.at('2026-11-15T02:00:00Z')
  await sb.fanout(['upkeep'], { env: { FANOUT_TEST_STEPS: 'fail,ok' } })
  const st = readStatus(sb)
  expect(st.last_upkeep_ok).toBe('2026-11-15T01:00:00.000Z')
  expect(st.last_upkeep_attempt).toBe('2026-11-15T02:00:00.000Z')
}, 30000)

test('a second upkeep returns at once', async () => {
  const sb = sandbox().at(BASE)
  const env = { FANOUT_TEST_STEPS: 'slow' }
  const a = sb.start(['upkeep'], { env })
  const b = sb.start(['upkeep'], { env })
  const [ra, rb] = await Promise.all([a.done(), b.done()])
  expect(ra.code).toBe(0)
  expect(rb.code).toBe(0)
  const printed = [ra.stdout, rb.stdout].filter((s) => s.includes('upkeep already running'))
  expect(printed).toHaveLength(1)
  expect(upkeepEvents(sb).filter((e) => e.step === 'slow')).toHaveLength(1)
}, 30000)

test('a stale lock is taken over', async () => {
  const sb = sandbox().at(BASE)
  mkdirSync(join(sb.home, 'run'), { recursive: true })
  writeFileSync(join(sb.home, 'run', 'upkeep.lock'), JSON.stringify({ pid: 999999999, startTicks: 1 }))
  const r = await sb.fanout(['upkeep'], { env: { FANOUT_TEST_STEPS: 'ok' } })
  expect(r.code).toBe(0)
  expect(upkeepEvents(sb).some((e) => e.step === 'ok')).toBe(true)
}, 30000)

test('upkeep cannot reach a paid row', async () => {
  const sb = sandbox().at(BASE)
  sb.catalog(
    'harness,model,efforts,tier,billing,price_in,price_cached,price_out,price_call,min_brief_bytes,data_class,status,family\n' +
      'fake2,f1-paid,medium|low,1,paid,1.00,0.10,2.00,,0,any,active,fam-paid\n'
  )
  const brief = sb.brief('Extract the names from a.txt, nothing else.')
  const r = await sb.fanout(['upkeep'], {
    env: {
      FANOUT_TEST_STEPS: 'probe',
      FANOUT_TEST_BRIEF: brief,
      FANOUT_TEST_DIR: sb.repo
    }
  })
  expect(r.code).toBe(0)
  const probe = upkeepEvents(sb).find((e) => e.step === 'probe')
  expect(probe).toMatchObject({ status: 'failed' })
  expect(String(probe?.detail)).toContain('REFUSED no eligible candidate')
  expect(sb.ledger().some((e) => e.event === 'job_start')).toBe(false)
}, 30000)

test('--only runs one step', async () => {
  const sb = sandbox().at(BASE)
  const r = await sb.fanout(['upkeep', '--only', 'ok'], { env: { FANOUT_TEST_STEPS: 'fail,ok' } })
  expect(r.code).toBe(0)
  const events = upkeepEvents(sb)
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ step: 'ok', status: 'ok' })
}, 30000)

test('the lazy trigger fires only when due', async () => {
  const base = Date.parse(BASE)
  const iso = (agoMs: number): string => new Date(base - agoMs).toISOString()
  async function statusCase(
    setup: (sb: ReturnType<typeof sandbox>) => void,
    extraEnv: Record<string, string | undefined>
  ): Promise<{ code: number; log: string | undefined }> {
    const sb = sandbox().at(BASE)
    setup(sb)
    const log = join(sb.home, 'lazy.log')
    const r = await sb.fanout(['status', '--brief'], {
      env: { FANOUT_NO_LAZY: undefined, FANOUT_LAZY_LOG: log, ...extraEnv }
    })
    expect(r.code).toBe(0)
    return { code: r.code, log: existsSync(log) ? readFileSync(log, 'utf8') : undefined }
  }
  // Due: last success 25h ago, last attempt 2h ago.
  const due = await statusCase(
    (sb) => statusJson(sb, { last_upkeep_ok: iso(25 * 3600 * 1000), last_upkeep_attempt: iso(2 * 3600 * 1000) }),
    {}
  )
  expect(due.log).toBe('spawn upkeep --lazy\n')
  // Recent attempt: 10 minutes ago.
  const recent = await statusCase(
    (sb) => statusJson(sb, { last_upkeep_ok: iso(25 * 3600 * 1000), last_upkeep_attempt: iso(10 * 60 * 1000) }),
    {}
  )
  expect(recent.log).toBeUndefined()
  // Lazy disabled.
  const disabled = await statusCase(
    (sb) => statusJson(sb, { last_upkeep_ok: iso(25 * 3600 * 1000), last_upkeep_attempt: iso(2 * 3600 * 1000) }),
    { FANOUT_NO_LAZY: '1' }
  )
  expect(disabled.log).toBeUndefined()
  // No status.json at all.
  const missing = await statusCase(() => {}, {})
  expect(missing.log).toBe('spawn upkeep --lazy\n')
  // A live lock is held.
  const locked = sandbox().at(BASE)
  statusJson(locked, { last_upkeep_ok: iso(25 * 3600 * 1000), last_upkeep_attempt: iso(2 * 3600 * 1000) })
  const log = join(locked.home, 'lazy.log')
  const slow = locked.start(['upkeep'], { env: { FANOUT_TEST_STEPS: 'slow' } })
  await waitFor(() => existsSync(join(locked.home, 'run', 'upkeep.lock')))
  const r = await locked.fanout(['status', '--brief'], { env: { FANOUT_NO_LAZY: undefined, FANOUT_LAZY_LOG: log } })
  expect(r.code).toBe(0)
  expect(existsSync(log)).toBe(false)
  await slow.done()
  // An unwritable FANOUT_HOME never spawns and still exits 0.
  const unwritable = await statusCase(
    (sb) => statusJson(sb, { last_upkeep_ok: iso(25 * 3600 * 1000), last_upkeep_attempt: iso(2 * 3600 * 1000) }),
    { FANOUT_HOME: '/proc/fanout-nope' }
  )
  expect(unwritable.code).toBe(0)
  expect(unwritable.log).toBeUndefined()
}, 120000)

test('status shows the last 24 hours of upkeep', async () => {
  const sb = sandbox().at(BASE)
  await sb.fanout(['upkeep'], { env: { FANOUT_TEST_STEPS: 'fail,ok' } })
  const s = await sb.fanout(['status', '--brief'])
  expect(s.code).toBe(0)
  expect(s.stdout).toContain('UPKEEP (24h): fail failed, ok ok')
}, 30000)
