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

function jobId(stdout: string): string {
  return stdout.split('\n')[0].slice('FANOUT job='.length).split(' ')[0]
}

test('a tier 1 job escalates to tier 2', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['ok'], 'fake/f2-a': ['ok'] })
  const r1 = await sb.fanout(runArgs(sb))
  expect(r1.code).toBe(0)
  const j1 = jobId(r1.stdout)
  const r2 = await sb.fanout([...runArgs(sb), '--escalate-from', j1])
  expect(r2.code).toBe(0)
  const starts = sb.ledger().filter((e) => e.event === 'job_start')
  expect(starts[starts.length - 1]).toMatchObject({
    tier: 2,
    model: 'f2-a',
    reason: 'escalate',
    from_job: j1
  })
  const root = starts[starts.length - 1].root
  expect(root).toBe(starts[starts.length - 1].job)
  expect(root).not.toBe(j1)
}, 30000)

test('agy-style climb: effort first, then model, then refusal', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f2-a': ['ok'], 'fake/f3-z': ['ok'] })
  const r1 = await sb.fanout(runArgs(sb, ['--kind', 'edit']))
  const j1 = jobId(r1.stdout)
  const starts1 = sb.ledger().filter((e) => e.event === 'job_start')
  expect(starts1[starts1.length - 1]).toMatchObject({ model: 'f2-a', effort: 'medium' })
  const r2 = await sb.fanout([...runArgs(sb, ['--kind', 'edit']), '--escalate-from', j1])
  expect(r2.code).toBe(0)
  const j2 = jobId(r2.stdout)
  const starts2 = sb.ledger().filter((e) => e.event === 'job_start')
  expect(starts2[starts2.length - 1]).toMatchObject({ model: 'f2-a', effort: 'high', tier: 2 })
  const r3 = await sb.fanout([...runArgs(sb, ['--kind', 'edit']), '--escalate-from', j2])
  expect(r3.code).toBe(0)
  const j3 = jobId(r3.stdout)
  const starts3 = sb.ledger().filter((e) => e.event === 'job_start')
  expect(starts3[starts3.length - 1]).toMatchObject({ model: 'f3-z', effort: 'high', tier: 3 })
  const r4 = await sb.fanout([...runArgs(sb, ['--kind', 'edit']), '--escalate-from', j3])
  expect(r4.code).toBe(3)
  expect(r4.stdout.trim()).toBe('REFUSED already at the top tier')
}, 60000)

test('a top-tier job without a climb is refused', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake3/f3-a': ['ok'] })
  const r1 = await sb.fanout(runArgs(sb, ['--tier', '3', '--harness', 'fake3']))
  const j1 = jobId(r1.stdout)
  const r2 = await sb.fanout([...runArgs(sb, ['--tier', '3', '--harness', 'fake3']), '--escalate-from', j1])
  expect(r2.code).toBe(3)
  expect(r2.stdout.trim()).toBe('REFUSED already at the top tier')
}, 30000)

test('a cooling climb step is skipped', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f2-a': ['ok'], 'fake3/f3-a': ['ok'] })
  const r1 = await sb.fanout(runArgs(sb, ['--kind', 'edit']))
  const j1 = jobId(r1.stdout)
  const r2 = await sb.fanout([...runArgs(sb, ['--kind', 'edit']), '--escalate-from', j1])
  const j2 = jobId(r2.stdout)
  sb.seed([
    {
      ts: '2026-11-15T01:00:00.000Z',
      event: 'limit_hit',
      harness: 'fake',
      model: 'f3-z',
      scope: 'model',
      outcome: 'rate_limited',
      source: 'backoff',
      until: '2026-11-15T02:00:00.000Z'
    }
  ])
  const r3 = await sb.fanout([...runArgs(sb, ['--kind', 'edit']), '--escalate-from', j2])
  expect(r3.code).toBe(0)
  const starts = sb.ledger().filter((e) => e.event === 'job_start')
  expect(starts[starts.length - 1]).toMatchObject({ tier: 3, model: 'f3-a', reason: 'escalate' })
}, 60000)

test('escalate cannot be combined with --model or --pin', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['ok'] })
  const r1 = await sb.fanout(runArgs(sb))
  const j1 = jobId(r1.stdout)
  const r2 = await sb.fanout([...runArgs(sb), '--escalate-from', j1, '--model', 'f2-b'])
  expect(r2.code).toBe(2)
  expect(r2.stderr).toContain('--escalate-from cannot be combined with --model or --pin')
  const r3 = await sb.fanout([...runArgs(sb), '--escalate-from', j1, '--pin'])
  expect(r3.code).toBe(2)
  expect(r3.stderr).toContain('--escalate-from cannot be combined with --model or --pin')
}, 30000)

test('an unknown job exits 2', async () => {
  const sb = sandbox()
  const r = await sb.fanout(runArgs(sb, ['--escalate-from', '01HZZZZZZZZZZZZZZZZZZZZZZZ']))
  expect(r.code).toBe(2)
  expect(r.stderr).toContain('unknown job 01HZZZZZZZZZZZZZZZZZZZZZZZ')
}, 30000)

test("the climb step's effort reaches the worker", async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f2-a': ['ok'] })
  const r1 = await sb.fanout(runArgs(sb, ['--kind', 'edit']))
  const j1 = jobId(r1.stdout)
  const r2 = await sb.fanout([...runArgs(sb, ['--kind', 'edit']), '--dry-run', '--escalate-from', j1])
  expect(r2.code).toBe(0)
  expect(r2.stdout).toMatch(/^DRYRUN fake\/f2-a effort=high/m)
})
