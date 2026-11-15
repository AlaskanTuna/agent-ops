import { test, expect } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { sandbox } from './helpers/sandbox'

const BASE = '2026-11-15T01:00:00Z'
const NO_PAID = 'harness,model,status\nfake2,f1-paid,retired\nfake3,f1-paid-b,retired\n'
const HEADER =
  'harness,model,efforts,tier,billing,price_in,price_cached,price_out,price_call,min_brief_bytes,data_class,status,family,aliases,aa_slug,climb,upstream,note\n'

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

function smokeEvents(sb: ReturnType<typeof sandbox>): Record<string, unknown>[] {
  return sb.ledger().filter((e) => e.event === 'smoke')
}

function jobStarts(sb: ReturnType<typeof sandbox>, model?: string): Record<string, unknown>[] {
  return sb.ledger().filter((e) => e.event === 'job_start' && (model === undefined || e.model === model))
}

async function smokeOnly(sb: ReturnType<typeof sandbox>) {
  return sb.fanout(['upkeep', '--only', 'smoke'])
}

test('a passing smoke makes the trial row routable as the last of its tier', async () => {
  const sb = sandbox().at(BASE)
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake3/f1-trial': ['smoke_ok'] })
  const u = await smokeOnly(sb)
  expect(u.code).toBe(0)
  const ev = smokeEvents(sb)
  expect(ev).toHaveLength(1)
  expect(ev[0]).toMatchObject({ harness: 'fake3', model: 'f1-trial', result: 'pass' })
  const last = sb.learned('state.jsonl')
  expect(last[last.length - 1]).toMatchObject({ kind: 'smoke', key: 'fake3/f1-trial', result: 'pass' })
  const pick = await sb.fanout(['pick', '--all', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'transcribe'])
  const cands = pick.stdout.split('\n').filter((l) => l.startsWith('CAND '))
  const tier1 = cands.filter((l) => l.includes('tier=1'))
  const lastTier1 = tier1[tier1.length - 1]
  expect(lastTier1).toContain('fake3/f1-trial')
  expect(lastTier1).toContain('status=trial')
}, 60000)

test('a wrong smoke fails and is not retried for 7 days', async () => {
  const sb = sandbox().at(BASE)
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake3/f1-trial': ['smoke_wrong'] })
  await smokeOnly(sb)
  const ev = smokeEvents(sb)
  expect(ev).toHaveLength(1)
  expect(ev[0]).toMatchObject({ result: 'fail' })
  expect(String(ev[0].detail)).toContain('smoke.txt has wrong bytes')
  sb.at('2026-11-18T01:00:00Z')
  await smokeOnly(sb)
  expect(smokeEvents(sb)).toHaveLength(1)
  sb.at('2026-11-23T01:00:00Z')
  await smokeOnly(sb)
  expect(smokeEvents(sb)).toHaveLength(2)
}, 60000)

test('a limit is skipped and tried again', async () => {
  const sb = sandbox().at(BASE)
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake3/f1-trial': ['rate_limited', 'smoke_ok'] })
  await smokeOnly(sb)
  const first = smokeEvents(sb)
  expect(first).toHaveLength(1)
  expect(first[0]).toMatchObject({ result: 'skipped' })
  expect(sb.learned('state.jsonl').some((l) => l.kind === 'smoke')).toBe(false)
  await smokeOnly(sb)
  const second = smokeEvents(sb)
  expect(second).toHaveLength(2)
  expect(second[1]).toMatchObject({ result: 'pass' })
}, 60000)

test('paid rows are never smoke-tested', async () => {
  const sb = sandbox().at(BASE)
  sb.catalogPrivate('harness,model,status\nfake2,f1-paid,trial\n')
  const u = await smokeOnly(sb)
  expect(u.code).toBe(0)
  expect(jobStarts(sb, 'f1-paid')).toHaveLength(0)
  const step = sb.ledger().find((e) => e.event === 'upkeep' && e.step === 'smoke')
  expect(String(step?.detail)).toContain('1 paid rows promote on first use')
  const s = await sb.fanout(['status', '--brief'])
  expect(s.stdout).toContain('NEW (paid, promoted on first use): fake2/f1-paid')
}, 60000)

test('per-call rows are capped at 3 per upkeep with 2 turns each', async () => {
  const sb = sandbox().at(BASE)
  let csv = HEADER
  csv += 'fake,f1-a,medium|low,1,subscription,,,,,0,any,active,f1-a,,,,,\n'
  csv += 'fake2,f1-c,medium|low,1,subscription,,,,,0,any,active,f1-c,,,,,\n'
  for (let n = 1; n <= 5; n++) {
    csv += `fake3,f1-call-${n},,1,per_call,,,,2,6000,any,trial,f1-call-${n},,,,,\n`
  }
  sb.catalog(csv)
  const script: Record<string, string[]> = {}
  for (let n = 1; n <= 5; n++) script[`fake3/f1-call-${n}`] = ['smoke_ok']
  sb.script(script)
  await smokeOnly(sb)
  const first = jobStarts(sb).filter((e) => e.billing === 'per_call')
  expect(first).toHaveLength(3)
  for (const j of first) expect(j).toMatchObject({ billing: 'per_call', calls_est: 2 })
  await smokeOnly(sb)
  expect(jobStarts(sb).filter((e) => e.billing === 'per_call')).toHaveLength(5)
}, 120000)

test('a trial paid row is the last candidate of its tier', async () => {
  const sb = sandbox().at(BASE)
  sb.catalogPrivate('harness,model,status\nfake2,f1-paid,trial\n')
  const pick = await sb.fanout(['pick', '--all', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'transcribe'])
  expect(pick.code).toBe(0)
  const cands = pick.stdout.split('\n').filter((l) => l.startsWith('CAND '))
  const num = (m: string): number => cands.findIndex((l) => l.includes(m))
  const paid = num('fake2/f1-paid')
  expect(paid).toBeGreaterThan(-1)
  expect(cands[paid]).toContain('status=trial')
  for (const l of cands) {
    if (!l.includes('tier=1') || l.includes('fake2/f1-paid')) continue
    expect(cands.indexOf(l)).toBeLessThan(paid)
  }
  for (const l of cands) {
    if (!l.includes('tier=2')) continue
    expect(cands.indexOf(l)).toBeGreaterThan(paid)
  }
}, 30000)

test('the first real job promotes a paid trial row', async () => {
  const sb = sandbox().at(BASE)
  sb.catalogPrivate('harness,model,status\nfake2,f1-paid,trial\n')
  sb.script({ 'fake2/f1-paid': ['ok'] })
  const r = await sb.fanout(runArgs(sb, ['--model', 'f1-paid']))
  expect(r.code).toBe(0)
  const lines = sb.learned('state.jsonl')
  expect(lines[lines.length - 1]).toMatchObject({ kind: 'first_use', key: 'fake2/f1-paid', result: 'pass' })
  const pick = await sb.fanout(['pick', '--all', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'transcribe'])
  const line = pick.stdout.split('\n').find((l) => l.startsWith('CAND ') && l.includes('fake2/f1-paid'))
  expect(line).toContain('status=active')
}, 60000)

test('a failed first use hides the row for 7 days', async () => {
  const sb = sandbox().at(BASE)
  sb.catalogPrivate('harness,model,status\nfake2,f1-paid,trial\n')
  sb.script({ 'fake2/f1-paid': ['ok_no_write'] })
  const r = await sb.fanout(runArgs(sb, ['--model', 'f1-paid']))
  expect(r.code).toBe(1)
  const lines = sb.learned('state.jsonl')
  expect(lines[lines.length - 1]).toMatchObject({ kind: 'first_use', key: 'fake2/f1-paid', result: 'fail' })
  sb.at('2026-11-18T01:00:00Z')
  const p3 = await sb.fanout(['pick', '--all', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'transcribe'])
  expect(p3.stdout).not.toContain('fake2/f1-paid')
  sb.at('2026-11-23T01:00:00Z')
  const p8 = await sb.fanout(['pick', '--all', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'transcribe'])
  expect(p8.stdout).toContain('fake2/f1-paid')
}, 60000)

test('a paid trial row takes one job at a time', async () => {
  const sb = sandbox().at(BASE)
  sb.catalogPrivate(
    'harness,model,status\nfake,f1-a,retired\nfake,f1-b,retired\nfake2,f1-c,retired\nfake3,f1-paid-b,retired\nfake3,f1-pub,retired\nfake3,f1-call,retired\nfake2,f1-paid,trial\n'
  )
  sb.script({ 'fake2/f1-paid': ['ok_slow'], 'fake/f2-a': ['ok'] })
  const a = sb.start(runArgs(sb), { env: { FAKE_SLEEP_S: '2' } })
  const b = sb.start(runArgs(sb), { env: { FAKE_SLEEP_S: '2' } })
  const [ra, rb] = await Promise.all([a.done(), b.done()])
  expect(ra.code).toBe(0)
  expect(rb.code).toBe(0)
  expect(jobStarts(sb, 'f1-paid')).toHaveLength(1)
  expect(jobStarts(sb, 'f2-a')).toHaveLength(1)
}, 120000)

test('a smoke-passed free trial row graduates after 5 accepted jobs', async () => {
  const sb = sandbox().at(BASE)
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake3/f1-trial': ['smoke_ok'] })
  await smokeOnly(sb)
  for (let i = 0; i < 5; i++) {
    sb.script({ 'fake3/f1-trial': ['ok'] })
    const r = await sb.fanout(runArgs(sb, ['--model', 'f1-trial']))
    expect(r.code).toBe(0)
    const m = /^FANOUT job=(\w{26}) /m.exec(r.stdout)
    expect(m).not.toBeNull()
    const v = await sb.fanout(['verdict', m![1], 'accepted'])
    expect(v.code).toBe(0)
  }
  const pick = await sb.fanout(['pick', '--all', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'transcribe'])
  const line = pick.stdout.split('\n').find((l) => l.startsWith('CAND ') && l.includes('fake3/f1-trial'))
  expect(line).toContain('status=active')
  const cands = pick.stdout.split('\n').filter((l) => l.startsWith('CAND '))
  const pos = (m: string): number => cands.findIndex((l) => l.includes(m))
  expect(pos('fake/f1-a')).toBeLessThan(pos('fake/f1-b'))
  expect(pos('fake/f1-b')).toBeLessThan(pos('fake2/f1-c'))
  expect(pos('fake2/f1-c')).toBeLessThan(pos('fake3/f1-trial'))
  expect(pick.stdout).not.toContain('billing=paid')
}, 120000)

test('a trial row yields to a free proven row', async () => {
  const sb = sandbox().at(BASE)
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake3/f1-trial': ['smoke_ok'] })
  await smokeOnly(sb)
  sb.script({ 'fake/f1-a': ['ok'], 'fake3/f1-trial': ['ok'] })
  const r = await sb.fanout(runArgs(sb))
  expect(r.code).toBe(0)
  expect(r.stdout.split('\n')[0]).toMatch(/model=f1-a outcome=ok attempt=1/)
}, 60000)

test('proof outlives the event window', async () => {
  const sb = sandbox().at(BASE)
  sb.catalogPrivate('harness,model,status\nfake2,f1-paid,trial\n')
  sb.script({ 'fake3/f1-trial': ['smoke_ok'] })
  await smokeOnly(sb)
  sb.script({ 'fake2/f1-paid': ['ok'] })
  await sb.fanout(runArgs(sb, ['--model', 'f1-paid']))
  rmSync(join(sb.home, 'events'), { recursive: true, force: true })
  const pick = await sb.fanout(['pick', '--all', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'transcribe'])
  expect(pick.stdout).toContain('fake3/f1-trial')
  expect(pick.stdout).toContain('fake2/f1-paid')
}, 120000)

test('status counts', async () => {
  const sb = sandbox().at(BASE)
  sb.catalogPrivate(
    HEADER +
      'fake2,f1-paid,,,,,,,,,,,retired\n' +
      'fake3,f1-paid-b,,,,,,,,,,,retired\n' +
      'fake3,f1-trial2,,1,free,,,,,0,any,trial,f1-trial2\n'
  )
  sb.script({ 'fake3/f1-trial': ['smoke_ok'], 'fake3/f1-trial2': ['smoke_wrong'] })
  await smokeOnly(sb)
  const s = await sb.fanout(['status', '--brief'])
  expect(s.stdout).toContain('SMOKE pass=1 fail=1 pending=0')
}, 60000)
