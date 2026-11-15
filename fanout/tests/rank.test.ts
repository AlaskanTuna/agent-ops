import { test, expect } from 'bun:test'
import { sandbox } from './helpers/sandbox'

function base(sb: ReturnType<typeof sandbox>, extra: string[] = []) {
  return ['pick', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'transcribe', ...extra]
}

test('PAID names the first paid candidate and its prior estimate', async () => {
  const s = sandbox()
  const r = await s.fanout(base(s))
  expect(r.code).toBe(0)
  expect(r.stdout).toMatch(/^PAID fake3\/f1-paid-b ESTIMATE \$0\.07 \(prior; fewer than 5 samples\)$/m)
})

test('paid rows are ordered by estimated cost', async () => {
  const s = sandbox()
  const r = await s.fanout(base(s, ['--all']))
  const lines = r.stdout.split('\n').filter((l) => l.startsWith('CAND '))
  const cheap = lines.findIndex((l) => l.includes('fake3/f1-paid-b'))
  const dear = lines.findIndex((l) => l.includes('fake2/f1-paid'))
  const f1c = lines.findIndex((l) => l.includes('fake2/f1-c'))
  const firstTier2 = lines.findIndex((l) => l.includes('tier=2'))
  expect(cheap).toBeGreaterThan(-1)
  expect(cheap).toBeLessThan(dear)
  expect(cheap).toBeGreaterThan(f1c)
  expect(dear).toBeGreaterThan(f1c)
  expect(dear).toBeLessThan(firstTier2)
})

test('the estimate follows the kind', async () => {
  const s = sandbox()
  const r = await s.fanout(['pick', '--brief', s.brief(), '--dir', s.repo, '--kind', 'extract'])
  expect(r.stdout).toMatch(/^PAID fake3\/f1-paid-b ESTIMATE \$0\.02 \(prior; fewer than 5 samples\)$/m)
})

test('no paid row in the chain', async () => {
  const s = sandbox()
  const r = await s.fanout(['pick', '--brief', s.brief(), '--dir', s.repo, '--kind', 'edit'])
  expect(r.stdout).toMatch(/^PAID none \(no paid or per-call model in the chain\)$/m)
})

test('the pick itself is paid', async () => {
  const s = sandbox()
  s.catalogPrivate('harness,model,status\nfake,*,retired\nfake2,*,retired\n')
  const r = await s.fanout(base(s))
  expect(r.stdout.split('\n')[0]).toMatch(/^PICK harness=fake3 model=f1-paid-b tier=1 billing=paid/)
  expect(r.stdout).toMatch(/^PAID fake3\/f1-paid-b ESTIMATE/m)
})

test('per-call estimate in MC', async () => {
  const s = sandbox()
  s.catalogPrivate('harness,model,status\nfake,*,retired\nfake2,*,retired\nfake3,f1-paid-b,retired\n')
  const r = await s.fanout(['pick', '--brief', s.brief(undefined, 7000), '--dir', s.repo, '--kind', 'transcribe'])
  expect(r.stdout).toMatch(/^PAID fake3\/f1-call ESTIMATE 16 MC \(8 turns x 2 MC, upper-bound guess\)$/m)
  const r4 = await s.fanout([
    'pick',
    '--brief',
    s.brief(undefined, 7000),
    '--dir',
    s.repo,
    '--kind',
    'transcribe',
    '--max-turns',
    '4'
  ])
  expect(r4.stdout).toMatch(/^PAID fake3\/f1-call ESTIMATE 8 MC \(4 turns x 2 MC, upper-bound guess\)$/m)
})

test('usd formatting', async () => {
  const s = sandbox()
  s.catalogPrivate('harness,model,price_in,price_cached,price_out\nfake2,f1-paid,0.1,0,0.1\n')
  const r = await s.fanout(['pick', '--brief', s.brief(), '--dir', s.repo, '--kind', 'extract', '--all'])
  expect(r.stdout).toMatch(/^PAID fake2\/f1-paid ESTIMATE \$0\.0033 \(prior; fewer than 5 samples\)$/m)
  const lines = r.stdout.split('\n').filter((l) => l.startsWith('CAND '))
  expect(lines.findIndex((l) => l.includes('fake2/f1-paid'))).toBeLessThan(
    lines.findIndex((l) => l.includes('fake3/f1-paid-b'))
  )
})

test('pick accepts --max-turns', async () => {
  const s = sandbox()
  const r = await s.fanout(base(s, ['--max-turns', '4']))
  expect(r.code).toBe(0)
})
