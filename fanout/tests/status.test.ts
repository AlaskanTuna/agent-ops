import { test, expect } from 'bun:test'
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

const NO_PAID = 'harness,model,status\nfake2,f1-paid,retired\nfake3,f1-paid-b,retired\n'
const PAID_ONLY = 'harness,model,status\nfake,*,retired\nfake2,f1-c,retired\nfake3,f1-paid-b,retired\n'

function fanoutJob(stdout: string): string {
  const m = /^FANOUT job=(\w{26}) /m.exec(stdout)
  if (!m) throw new Error(`no FANOUT line in: ${stdout}`)
  return m[1]
}

test('an empty ledger prints exactly fanout: ok', async () => {
  const sb = sandbox()
  const r = await sb.fanout(['status', '--brief'])
  expect(r.code).toBe(0)
  expect(r.stdout).toBe('fanout: ok\n')
}, 30000)

test('a clean subscription job leaves nothing to report', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  const r = await sb.fanout(RUN(sb))
  expect(r.code).toBe(0)
  const s = await sb.fanout(['status', '--brief'])
  expect(s.stdout).toBe('fanout: ok\n')
}, 30000)

test('a fallback shows a cooldown and an unreported hop', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['rate_limited_reset'] })
  const r = await sb.fanout(RUN(sb))
  expect(r.code).toBe(0)
  const job = fanoutJob(r.stdout)
  sb.at('2026-11-15T01:05:00Z')
  const s = await sb.fanout(['status', '--brief'])
  expect(s.code).toBe(0)
  expect(s.stdout).toContain('COOLDOWN fake/f1-a until 18:00 (rate_limited)\n')
  expect(s.stdout).toContain(`UNREPORTED ${job} fallback fake/f1-a -> fake/f1-b (run: fanout ack ${job})\n`)
}, 30000)

test('a paid job is unreported with its cost', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(PAID_ONLY)
  const r = await sb.fanout(RUN(sb))
  expect(r.code).toBe(0)
  const job = fanoutJob(r.stdout)
  const s = await sb.fanout(['status', '--brief'])
  expect(s.stdout).toContain(
    `UNREPORTED ${job} paid fake2/f1-paid: estimated $0.14, actual $0.0014 (run: fanout ack ${job})\n`
  )
}, 30000)

test('a pre-start reroute is unreported', async () => {
  const sb = sandbox().at('2026-11-15T01:05:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.seed([
    {
      ts: '2026-11-15T01:00:00.000Z',
      event: 'limit_hit',
      job: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
      root: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
      harness: 'fake',
      model: 'f1-a',
      scope: 'model',
      outcome: 'rate_limited',
      source: 'backoff',
      until: '2026-11-15T01:15:00.000Z'
    }
  ])
  const r = await sb.fanout([...RUN(sb), '--expect', 'fake/f1-a'])
  expect(r.code).toBe(0)
  const job = fanoutJob(r.stdout)
  const s = await sb.fanout(['status', '--brief'])
  expect(s.stdout).toContain(`UNREPORTED ${job} reroute fake/f1-a -> fake/f1-b (run: fanout ack ${job})\n`)
}, 30000)

test('a chain still running is RUNNING, not unreported', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['rate_limited'], 'fake/f1-b': ['ok_slow'] })
  sb.env.FAKE_SLEEP_S = '4'
  const p = sb.start(RUN(sb))
  await waitFor(() => sb.ledger().filter((e) => e.event === 'job_start').length === 2, 10000)
  const s1 = await sb.fanout(['status', '--brief'])
  const starts = sb.ledger().filter((e) => e.event === 'job_start')
  const root = String(starts[0].job)
  expect(s1.stdout).toContain(`RUNNING ${root} fake/f1-b since 09:00\n`)
  expect(s1.stdout).not.toContain('UNREPORTED')
  const r = await p.done()
  expect(r.code).toBe(0)
  const s2 = await sb.fanout(['status', '--brief'])
  expect(s2.stdout).toContain('UNREPORTED')
}, 30000)

test('upkeep jobs are never unreported', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['rate_limited'] })
  const r = await sb.fanout(RUN(sb), { env: { FANOUT_CALLER: 'upkeep' } })
  expect(r.code).toBe(0)
  const s = await sb.fanout(['status', '--brief'])
  expect(s.stdout).toContain('COOLDOWN')
  expect(s.stdout).not.toContain('UNREPORTED')
}, 30000)

test('status without --brief lists the catalog', async () => {
  const sb = sandbox()
  const s = await sb.fanout(['status'])
  expect(s.code).toBe(0)
  expect(s.stdout).toContain('fake/f1-a tier=1 active subscription any\n')
  expect(s.stdout).toContain('fake3/f1-pub tier=1 active free public-only\n')
  expect(s.stdout).toContain('fake3/f1-trial tier=1 trial free any\n')
}, 30000)
