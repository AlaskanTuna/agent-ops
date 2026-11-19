import { test, expect } from 'bun:test'
import { sandbox } from './helpers/sandbox'

function sb() {
  return sandbox()
}

test('transcribe starts at tier 1 and prints PICK and THEN lines', async () => {
  const s = sb()
  const r = await s.fanout(['pick', '--brief', s.brief(), '--dir', s.repo, '--kind', 'transcribe'])
  expect(r.code).toBe(0)
  expect(r.stdout.split('\n')[0]).toBe(
    'PICK harness=fake model=f1-a tier=1 billing=subscription effort=medium data=private'
  )
  expect(r.stdout).toMatch(/^THEN fake\/f1-b, fake2\/f1-c/m)
})

test('a private catalog row overrides only its non-empty cells', async () => {
  const s = sb()
  s.catalogPrivate('harness,model,tier\nfake,f2-a,1\n')
  const r = await s.fanout(['pick', '--all', '--brief', s.brief(), '--dir', s.repo, '--kind', 'transcribe'])
  expect(r.stdout).toMatch(/^CAND \d+ fake\/f2-a tier=1 effort=medium /m) // efforts still from the default layer
})

test('edit starts at tier 2', async () => {
  const s = sb()
  const r = await s.fanout(['pick', '--brief', s.brief(), '--dir', s.repo, '--kind', 'edit'])
  expect(r.code).toBe(0)
  expect(r.stdout.split('\n')[0]).toBe(
    'PICK harness=fake model=f2-a tier=2 billing=subscription effort=medium data=private'
  )
})

test('--tier overrides the kind', async () => {
  const s = sb()
  const r = await s.fanout(['pick', '--brief', s.brief(), '--dir', s.repo, '--kind', 'transcribe', '--tier', '3'])
  expect(r.code).toBe(0)
  expect(r.stdout.split('\n')[0]).toMatch(/^PICK harness=fake model=f3-z tier=3/)
  const all = await s.fanout([
    'pick',
    '--all',
    '--brief',
    s.brief(),
    '--dir',
    s.repo,
    '--kind',
    'transcribe',
    '--tier',
    '3'
  ])
  expect(all.stdout).not.toMatch(/tier=1/)
  expect(all.stdout).not.toMatch(/tier=2/)
})

test('manual trial rows are not routed', async () => {
  const s = sb()
  const r = await s.fanout(['pick', '--all', '--brief', s.brief(), '--dir', s.repo, '--kind', 'transcribe'])
  expect(r.stdout).not.toMatch(/f1-trial/)
  for (const line of r.stdout.split('\n').filter((l) => l.startsWith('CAND '))) {
    expect(line).toMatch(/status=active$/)
  }
})

test('per_call rows need a large brief', async () => {
  const s = sb()
  const small = await s.fanout([
    'pick',
    '--all',
    '--brief',
    s.brief(undefined, 100),
    '--dir',
    s.repo,
    '--kind',
    'transcribe'
  ])
  expect(small.stdout).not.toMatch(/f1-call/)
  const big = await s.fanout([
    'pick',
    '--all',
    '--brief',
    s.brief(undefined, 7000),
    '--dir',
    s.repo,
    '--kind',
    'transcribe'
  ])
  expect(big.stdout).toMatch(/fake3\/f1-call/)
  const lines = big.stdout.split('\n').filter((l) => l.startsWith('CAND '))
  const callIdx = lines.findIndex((l) => l.includes('fake3/f1-call'))
  const paidIdx = lines.findIndex((l) => l.includes('fake2/f1-paid'))
  expect(callIdx).toBeGreaterThan(paidIdx)
})

test('retired private row hides a model', async () => {
  const s = sb()
  s.catalogPrivate('harness,model,status\nfake2,f1-c,retired\n')
  const r = await s.fanout(['pick', '--all', '--brief', s.brief(), '--dir', s.repo, '--kind', 'transcribe'])
  expect(r.stdout).not.toMatch(/fake2\/f1-c/)
})

test('a wildcard row retires a whole harness', async () => {
  const s = sb()
  s.catalogPrivate('harness,model,status\nfake3,*,retired\n')
  const r = await s.fanout(['pick', '--all', '--brief', s.brief(), '--dir', s.repo, '--kind', 'transcribe'])
  expect(r.stdout).not.toMatch(/fake3\//)
})

test('a specific private row beats a wildcard row', async () => {
  const s = sb()
  s.catalogPrivate('harness,model,status\nfake3,*,retired\nfake3,f1-pub,active\n')
  const r = await s.fanout(['pick', '--all', '--brief', s.brief(), '--dir', s.repo, '--kind', 'transcribe', '--public'])
  expect(r.stdout).toMatch(/fake3\/f1-pub/)
  expect(r.stdout).not.toMatch(/fake3\/f1-call/)
})

test('layer order is private over default over auto', async () => {
  const s = sb()
  s.seedLearned('catalog.auto.json', [
    {
      rows: [
        { harness: 'fake', model: 'f2-a', tier: 1, billing: 'subscription', status: 'active' },
        { harness: 'fake', model: 'f2-new', tier: 2, billing: 'subscription', status: 'active' }
      ]
    }
  ])
  const r = await s.fanout(['pick', '--all', '--brief', s.brief(), '--dir', s.repo, '--kind', 'edit'])
  expect(r.stdout).toMatch(/fake\/f2-a tier=2/)
  expect(r.stdout).toMatch(/fake\/f2-new/)
})

test('a private row for a model no other layer knows waits for it unless it states billing', async () => {
  const s = sb()
  s.catalogPrivate(
    'harness,model,efforts,tier,status,billing,price_in,price_out\nfake,f9-new,,3,,,,\nfake,f9-full,,3,,paid,1,2\n'
  )
  const r = await s.fanout(['pick', '--all', '--brief', s.brief(), '--dir', s.repo, '--kind', 'transcribe'])
  expect(r.code).toBe(0)
  // Never treated as a free subscription model just because the cells are empty.
  expect(r.stdout).not.toMatch(/fake\/f9-new/)
  expect(r.stdout).toMatch(/^CAND \d+ fake\/f9-full tier=3 .*billing=paid/m)
})

test('a bad row is skipped with a warning and pick still works', async () => {
  const s = sb()
  s.catalog(s.fixtureCatalog() + 'fake,bad,,9,subscription,,,,,,,active,,,,,,\n')
  const r = await s.fanout(['pick', '--brief', s.brief(), '--dir', s.repo, '--kind', 'transcribe'])
  expect(r.code).toBe(0)
  expect(r.stderr).toMatch(/WARN catalog row skipped: fake\/bad: tier must be 1, 2 or 3/)
  expect(r.stdout).not.toMatch(/fake\/bad/)
})

test('a private tier outside 1 to 3 warns and keeps the old tier', async () => {
  const s = sb()
  s.catalogPrivate('harness,model,tier\nfake,f2-a,4\n')
  const r = await s.fanout(['pick', '--all', '--brief', s.brief(), '--dir', s.repo, '--kind', 'transcribe'])
  expect(r.code).toBe(0)
  expect(r.stderr).toMatch(/WARN private catalog fake\/f2-a: tier 4 ignored, tier must be 1, 2 or 3/)
  expect(r.stdout).toMatch(/^CAND \d+ fake\/f2-a tier=2 /m)
})

test('an unpriced paid row is skipped', async () => {
  const s = sb()
  s.catalog(s.fixtureCatalog() + 'fake2,noprice,medium|low,1,paid,1.00,,,,,,active,,,,,,\n')
  const r = await s.fanout(['pick', '--brief', s.brief(), '--dir', s.repo, '--kind', 'transcribe'])
  expect(r.code).toBe(0)
  expect(r.stderr).toMatch(/WARN catalog row skipped: fake2\/noprice: paid row needs price_in and price_out/)
  expect(r.stdout).not.toMatch(/noprice/)
})

test('--harness prefers within a tier and never changes the tier', async () => {
  const s = sb()
  const r = await s.fanout([
    'pick',
    '--brief',
    s.brief(),
    '--dir',
    s.repo,
    '--kind',
    'transcribe',
    '--harness',
    'fake2'
  ])
  expect(r.stdout.split('\n')[0]).toBe(
    'PICK harness=fake2 model=f1-c tier=1 billing=subscription effort=medium data=private'
  )
  expect(r.stdout).toMatch(/^THEN fake\/f1-a/m)
  const r3 = await s.fanout([
    'pick',
    '--brief',
    s.brief(),
    '--dir',
    s.repo,
    '--kind',
    'transcribe',
    '--harness',
    'fake3'
  ])
  expect(r3.stdout.split('\n')[0]).toMatch(/^PICK harness=fake3 model=f1-paid-b tier=1/)
  expect(r3.stdout).toMatch(/^THEN fake\/f1-a/m)
})

test('nothing eligible exits 3', async () => {
  const s = sb()
  s.catalogPrivate('harness,model,status\nfake,*,retired\nfake2,*,retired\nfake3,*,retired\n')
  const r = await s.fanout(['pick', '--brief', s.brief(), '--dir', s.repo, '--kind', 'transcribe'])
  expect(r.code).toBe(3)
  expect(r.stdout.trim()).toBe('REFUSED no eligible candidate')
})

test('default catalog: argon is tier 2 until the private catalog says 3', async () => {
  const s = sb()
  const first = await s.fanout(
    ['pick', '--all', '--brief', s.brief(), '--dir', s.repo, '--kind', 'edit', '--harness', 'agy'],
    { noCatalog: true }
  )
  expect(first.stdout).toMatch(/agy\/gemini-4-argon tier=2/)
  s.catalogPrivate('harness,model,tier\nagy,gemini-4-argon,3\n')
  const second = await s.fanout(
    ['pick', '--all', '--brief', s.brief(), '--dir', s.repo, '--kind', 'edit', '--harness', 'agy'],
    { noCatalog: true }
  )
  expect(second.stdout).toMatch(/agy\/gemini-4-argon tier=3/)
  for (const out of [first.stdout, second.stdout]) {
    expect(out).not.toMatch(/\b(kd|respan|devin|gonka)\//)
  }
  const pub = await s.fanout(
    ['pick', '--all', '--brief', s.brief(), '--dir', s.repo, '--kind', 'transcribe', '--public'],
    { noCatalog: true }
  )
  expect(pub.stdout).toMatch(/meta\/muse-spark-1\.3-contributor tier=1 .*class=public-only/)
})
