import { test, expect } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sandbox } from './helpers/sandbox'

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

const NO_PAID = 'harness,model,status\nfake2,f1-paid,retired\nfake3,f1-paid-b,retired\n'

function eventsText(sb: ReturnType<typeof sandbox>): string {
  const dir = join(sb.home, 'events')
  if (!existsSync(dir)) return ''
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n')
}

test('echoed brief and key never reach the ledger', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['echo_brief'] })
  const secret = 'sk-' + 'q'.repeat(24)
  const r = await sb.fanout(RUN(sb), { env: { FAKE_SECRET: secret } })
  expect(r.code).toBe(0)
  const text = eventsText(sb)
  expect(text).not.toContain('Rename foo in a.txt')
  expect(text).not.toContain(secret)
  const end = sb.ledger().find((e) => e.event === 'job_end')
  expect(String(end?.stderr_tail)).toContain('[brief echo removed]')
  expect(String(end?.stderr_tail)).toContain('key=[secret]')
}, 30000)

test('bearer tokens and key shapes are masked', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['custom_error'] })
  const bearer = 'a'.repeat(20)
  const aiza = 'AIza' + 'x'.repeat(35)
  const r = await sb.fanout(RUN(sb), { env: { FAKE_STDERR: `HTTP 429 Authorization: Bearer ${bearer} ${aiza}` } })
  expect(r.code).toBe(0)
  const end = sb.ledger().find((e) => e.event === 'job_end')
  const tail = String(end?.stderr_tail ?? '')
  expect(tail).not.toContain(bearer)
  expect(tail).not.toContain(aiza)
  expect(tail).toContain('[secret]')
}, 30000)

test('stderr_tail exists only for failures', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  const ok = await sb.fanout(RUN(sb))
  expect(ok.code).toBe(0)
  const okEnd = sb.ledger().find((e) => e.event === 'job_end')
  expect(okEnd).toBeDefined()
  expect('stderr_tail' in (okEnd ?? {})).toBe(false)
  sb.script({ 'fake/f1-a': ['rate_limited'] })
  const r = await sb.fanout(RUN(sb))
  expect(r.code).toBe(0)
  const ends = sb.ledger().filter((e) => e.event === 'job_end')
  expect(ends.length).toBe(3)
  expect(ends[1]).toMatchObject({ outcome: 'rate_limited' })
  expect(String(ends[1].stderr_tail ?? '')).not.toBe('')
  expect('stderr_tail' in (ends[2] ?? {})).toBe(false)
}, 30000)

test('an unwritable data directory still runs the worker', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'x'
  const fallback = join(process.env.TMPDIR ?? tmpdir(), `fanout-${uid}`)
  rmSync(fallback, { recursive: true, force: true })
  const r = await sb.fanout(RUN(sb), { env: { FANOUT_HOME: '/proc/fanout-nope' } })
  expect(r.code).toBe(0)
  expect(r.stderr.match(/WARN ledger unwritable; events not recorded/g) ?? []).toHaveLength(1)
  expect(r.stdout.split('\n')[0]).toMatch(/^FANOUT job=\w{26} harness=fake model=f1-a outcome=ok attempt=1$/)
  expect(existsSync(join(fallback, 'logs'))).toBe(true)
  expect(existsSync(join(fallback, 'run'))).toBe(true)
  rmSync(fallback, { recursive: true, force: true })
}, 30000)

test('a corrupt ledger line does not stop the run', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  mkdirSync(join(sb.home, 'events'), { recursive: true })
  appendFileSync(join(sb.home, 'events', '2026-11.jsonl'), '{not json\n')
  const r = await sb.fanout(RUN(sb))
  expect(r.code).toBe(0)
  const events = sb.ledger().filter((e) => e.event === 'job_start' || e.event === 'job_end')
  expect(events.length).toBe(2)
  expect(events[0]).toMatchObject({ event: 'job_start', v: 1 })
  expect(events[1]).toMatchObject({ event: 'job_end', v: 1 })
}, 30000)

test('a month boundary inside the window is read', async () => {
  const sb = sandbox().at('2026-10-31T23:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['rate_limited_reset'] })
  const r1 = await sb.fanout(RUN(sb))
  expect(r1.code).toBe(0)
  sb.at('2026-11-01T00:10:00Z')
  const r2 = await sb.fanout(RUN(sb))
  expect(r2.code).toBe(0)
  const starts = sb.ledger().filter((e) => e.event === 'job_start')
  const secondChain = starts.filter((e) => String(e.ts).startsWith('2026-11-01'))
  expect(secondChain[0]).toMatchObject({ harness: 'fake', model: 'f1-b' })
}, 30000)

test('events with v 2 are ignored', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.seed([
    {
      v: 2,
      ts: '2026-11-15T00:30:00.000Z',
      event: 'limit_hit',
      harness: 'fake',
      model: 'f1-a',
      scope: 'model',
      until: '2026-11-15T05:00:00.000Z'
    }
  ])
  const r = await sb.fanout(RUN(sb))
  expect(r.code).toBe(0)
  const starts = sb.ledger().filter((e) => e.event === 'job_start')
  expect(starts[0]).toMatchObject({ harness: 'fake', model: 'f1-a' })
}, 30000)

test('unknown fields are kept', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.seed([
    {
      ts: '2026-11-15T00:30:00.000Z',
      event: 'job_end',
      job: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
      harness: 'fake',
      model: 'f1-a',
      outcome: 'ok',
      zzz: 1
    }
  ])
  const r = await sb.fanout(RUN(sb))
  expect(r.code).toBe(0)
}, 30000)

test('an unreadable private catalog is refused', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  const dir = join(sb.home, '.config', 'agent-ops')
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'catalog.csv'))
  const r = await sb.fanout(RUN(sb))
  expect(r.code).toBe(3)
  expect(r.stdout).toBe('REFUSED cannot read ~/.config/agent-ops/catalog.csv\n')
  expect(sb.ledger()).toHaveLength(0)
}, 30000)

test('a private catalog without the key columns is refused', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate('tier,status\n1,active\n')
  const r = await sb.fanout(RUN(sb))
  expect(r.code).toBe(3)
  expect(r.stdout).toBe('REFUSED cannot read ~/.config/agent-ops/catalog.csv\n')
  expect(sb.ledger()).toHaveLength(0)
}, 30000)
