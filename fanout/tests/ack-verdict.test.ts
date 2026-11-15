import { test, expect } from 'bun:test'
import { chmodSync } from 'node:fs'
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

const NO_PAID = 'harness,model,status\nfake2,f1-paid,retired\nfake3,f1-paid-b,retired\n'
const PAID_ONLY = 'harness,model,status\nfake,*,retired\nfake2,f1-c,retired\nfake3,f1-paid-b,retired\n'

function firstJob(sb: ReturnType<typeof sandbox>): string {
  const starts = sb.ledger().filter((e) => e.event === 'job_start')
  return String(starts[0].job)
}

test('ack is refused while the chain runs', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.script({ 'fake/f1-a': ['ok_slow'] })
  sb.env.FAKE_SLEEP_S = '4'
  const p = sb.start(RUN(sb))
  await waitFor(() => sb.ledger().filter((e) => e.event === 'job_start').length === 1, 10000)
  const job = firstJob(sb)
  const r = await sb.fanout(['ack', job])
  expect(r.code).toBe(3)
  expect(r.stdout).toBe(`REFUSED chain ${job} is still running; wait with: fanout wait ${job}\n`)
  expect(sb.ledger().filter((e) => e.event === 'reported')).toHaveLength(0)
  await p.done()
}, 30000)

test('ack after the chain ends clears the whole chain', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['rate_limited'] })
  const r = await sb.fanout(RUN(sb))
  expect(r.code).toBe(0)
  const job = firstJob(sb)
  const a = await sb.fanout(['ack', job])
  expect(a.code).toBe(0)
  expect(a.stdout).toBe(`ACKED ${job}\n`)
  const reported = sb.ledger().filter((e) => e.event === 'reported')
  expect(reported).toHaveLength(1)
  expect(reported[0]).toMatchObject({ job, root: job })
  const s = await sb.fanout(['status', '--brief'])
  expect(s.stdout).not.toContain('UNREPORTED')
}, 30000)

test('a second ack is harmless', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['rate_limited'] })
  await sb.fanout(RUN(sb))
  const job = firstJob(sb)
  expect((await sb.fanout(['ack', job])).stdout).toBe(`ACKED ${job}\n`)
  const again = await sb.fanout(['ack', job])
  expect(again.code).toBe(0)
  expect(again.stdout).toBe(`ALREADY ${job}\n`)
  expect(sb.ledger().filter((e) => e.event === 'reported')).toHaveLength(1)
}, 30000)

test('ack of an unknown job exits 2', async () => {
  const sb = sandbox()
  const r = await sb.fanout(['ack', '01HZZZZZZZZZZZZZZZZZZZZZZZ'])
  expect(r.code).toBe(2)
  expect(r.stderr).toContain('unknown job 01HZZZZZZZZZZZZZZZZZZZZZZZ')
}, 30000)

test('ack with an unwritable ledger warns and exits 0', async () => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  await sb.fanout(RUN(sb))
  const job = firstJob(sb)
  chmodSync(join(sb.home, 'events'), 0o500)
  try {
    const r = await sb.fanout(['ack', job])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('WARN ledger unwritable; events not recorded')
  } finally {
    chmodSync(join(sb.home, 'events'), 0o700)
  }
}, 30000)

test('verdict writes the event and the learned line', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  const r = await sb.fanout(RUN(sb))
  expect(r.code).toBe(0)
  const job = firstJob(sb)
  const v = await sb.fanout(['verdict', job, 'accepted', '--note', 'ok'])
  expect(v.code).toBe(0)
  expect(v.stdout).toBe(`VERDICT ${job} accepted\n`)
  const events = sb.ledger().filter((e) => e.event === 'verdict')
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ job, accepted: true, note: 'ok' })
  const learned = sb.learned('state.jsonl')
  expect(learned[learned.length - 1]).toMatchObject({
    kind: 'judged',
    key: 'fake/f1-a',
    job,
    task_kind: 'transcribe',
    accepted: true,
    cost_usd: 0
  })
}, 30000)

test('the note is scrubbed and cut', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  await sb.fanout(RUN(sb))
  const job = firstJob(sb)
  const key = 'sk-' + 'q'.repeat(24)
  const v = await sb.fanout(['verdict', job, 'rejected', '--note', `${key} ${'x'.repeat(300)}`])
  expect(v.code).toBe(0)
  const stored = String(sb.ledger().find((e) => e.event === 'verdict')?.note ?? '')
  expect(stored.length).toBeLessThanOrEqual(200)
  expect(stored).not.toContain(key)
}, 30000)

test('bad verdict input exits 2', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  await sb.fanout(RUN(sb))
  const job = firstJob(sb)
  const bad = await sb.fanout(['verdict', job, 'maybe'])
  expect(bad.code).toBe(2)
  expect(bad.stderr).toContain('verdict must be accepted or rejected')
  const unknown = await sb.fanout(['verdict', 'nope', 'accepted'])
  expect(unknown.code).toBe(2)
  expect(unknown.stderr).toContain('unknown job nope')
}, 30000)

test('the history replaces the prior at 5 accepted jobs', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(PAID_ONLY)
  for (let i = 0; i < 5; i++) {
    const r = await sb.fanout(RUN(sb))
    expect(r.code).toBe(0)
    const starts = sb.ledger().filter((e) => e.event === 'job_start')
    const v = await sb.fanout(['verdict', String(starts[starts.length - 1].job), 'accepted'])
    expect(v.code).toBe(0)
  }
  const p = await sb.fanout(['pick', '--brief', sb.brief(BRIEF_TEXT), '--dir', sb.repo, '--kind', 'transcribe'])
  expect(p.stdout).toMatch(/^PAID fake2\/f1-paid ESTIMATE \$0\.0014 \(history; 5 samples\)$/m)
}, 120000)

test('four accepted jobs keep the prior', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(PAID_ONLY)
  for (let i = 0; i < 4; i++) {
    const r = await sb.fanout(RUN(sb))
    expect(r.code).toBe(0)
    const starts = sb.ledger().filter((e) => e.event === 'job_start')
    const v = await sb.fanout(['verdict', String(starts[starts.length - 1].job), 'accepted'])
    expect(v.code).toBe(0)
  }
  const p = await sb.fanout(['pick', '--brief', sb.brief(BRIEF_TEXT), '--dir', sb.repo, '--kind', 'transcribe'])
  expect(p.stdout).toMatch(/^PAID fake2\/f1-paid ESTIMATE \$0\.14 \(prior; fewer than 5 samples\)$/m)
}, 120000)

test('six processes append 1200 verdicts without a corrupt line', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  const r = await sb.fanout(RUN(sb))
  expect(r.code).toBe(0)
  const job = firstJob(sb)
  const before = sb
    .ledger()
    .map((e) => JSON.stringify(e))
    .join('\n')
  const beforeCount = before.split('\n').filter(Boolean).length
  const cli = new URL('../src/cli.ts', import.meta.url).pathname
  const script = `for i in $(seq 200); do bun ${cli} verdict ${job} accepted --note n$i; done`
  const procs = await Promise.all(
    Array.from({ length: 6 }, () =>
      Bun.spawn(['bash', '-c', script], { cwd: sb.repo, env: { ...sb.env } }).exited.then((code) => code)
    )
  )
  expect(procs).toEqual([0, 0, 0, 0, 0, 0])
  const { readFileSync, readdirSync } = await import('node:fs')
  const { join: joinPath } = await import('node:path')
  const lines: string[] = []
  for (const f of readdirSync(joinPath(sb.home, 'events'))) {
    if (!f.endsWith('.jsonl')) continue
    lines.push(
      ...readFileSync(joinPath(sb.home, 'events', f), 'utf8')
        .split('\n')
        .filter(Boolean)
    )
  }
  expect(lines.length).toBe(beforeCount + 1200)
  const ids = new Set<string>()
  for (const line of lines) {
    const e = JSON.parse(line) as { id?: unknown }
    expect(typeof e.id).toBe('string')
    ids.add(e.id as string)
  }
  expect(ids.size).toBe(lines.length)
}, 120000)
