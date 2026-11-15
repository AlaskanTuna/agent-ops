import { test, expect } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sandbox } from './helpers/sandbox'

function seedBench(sb: ReturnType<typeof sandbox>, values: Record<string, Record<string, unknown>>): void {
  mkdirSync(join(sb.home, 'learned'), { recursive: true })
  writeFileSync(join(sb.home, 'learned', 'benchmarks.json'), JSON.stringify({ values }))
}

function judgedLines(
  key: string,
  kind: string,
  total: number,
  accepted: number,
  cost = 0,
  firstJob = 1
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (let i = 0; i < total; i++) {
    out.push({ kind: 'judged', key, job: `J${firstJob + i}`, task_kind: kind, accepted: i < accepted, cost_usd: cost })
  }
  return out
}

function seedAll(
  sb: ReturnType<typeof sandbox>,
  bench: Record<string, Record<string, unknown>>,
  judged: unknown[]
): void {
  seedBench(sb, bench)
  sb.seedLearned('state.jsonl', judged)
}

const BENCH = {
  'fake/f1-a': { aa_intel: 40 },
  'fake/f1-b': { aa_intel: 30 },
  'fake2/f1-c': { aa_intel: 35 }
}

function all(sb: ReturnType<typeof sandbox>, extra: string[] = []) {
  return ['pick', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'transcribe', '--all', ...extra]
}

function candKeys(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter((l) => l.startsWith('CAND '))
    .map((l) => l.split(' ')[2] ?? '')
}

test('20 judged jobs at 90% put the row first', async () => {
  const sb = sandbox()
  seedAll(sb, BENCH, judgedLines('fake/f1-b', 'transcribe', 20, 18))
  const r = await sb.fanout(all(sb))
  expect(r.code).toBe(0)
  const order = candKeys(r.stdout).filter((k) => ['fake/f1-a', 'fake/f1-b', 'fake2/f1-c'].includes(k))
  expect(order[0]).toBe('fake/f1-b')
}, 30000)

test('19 judged jobs change nothing', async () => {
  const sb = sandbox()
  seedAll(sb, BENCH, judgedLines('fake/f1-b', 'transcribe', 19, 18))
  const r = await sb.fanout(all(sb))
  expect(r.code).toBe(0)
  const order = candKeys(r.stdout).filter((k) => ['fake/f1-a', 'fake/f1-b', 'fake2/f1-c'].includes(k))
  expect(order).toEqual(['fake/f1-a', 'fake2/f1-c', 'fake/f1-b'])
}, 30000)

test('a poor record goes last in its tier', async () => {
  const sb = sandbox()
  seedAll(sb, BENCH, judgedLines('fake/f1-b', 'transcribe', 20, 8))
  const r = await sb.fanout(all(sb))
  expect(r.code).toBe(0)
  const order = candKeys(r.stdout).filter((k) => ['fake/f1-a', 'fake/f1-b', 'fake2/f1-c'].includes(k))
  expect(order).toEqual(['fake/f1-a', 'fake2/f1-c', 'fake/f1-b'])
}, 30000)

test('exactly 50% is still band 0', async () => {
  const sb = sandbox()
  seedAll(sb, BENCH, judgedLines('fake/f1-b', 'transcribe', 20, 10))
  const r = await sb.fanout(all(sb))
  expect(r.code).toBe(0)
  expect(candKeys(r.stdout).filter((k) => ['fake/f1-a', 'fake/f1-b', 'fake2/f1-c'].includes(k))[0]).toBe('fake/f1-b')
}, 30000)

test('two scored rows sort by rate, then by cost per accepted job', async () => {
  const sb = sandbox()
  seedAll(sb, BENCH, [
    ...judgedLines('fake/f1-a', 'transcribe', 20, 19),
    ...judgedLines('fake/f1-b', 'transcribe', 20, 17, 0, 101)
  ])
  const byRate = await sb.fanout(all(sb))
  expect(candKeys(byRate.stdout).filter((k) => k === 'fake/f1-a' || k === 'fake/f1-b')[0]).toBe('fake/f1-a')

  seedAll(sb, BENCH, [
    ...judgedLines('fake/f1-a', 'transcribe', 20, 18, 0.01),
    ...judgedLines('fake/f1-b', 'transcribe', 20, 18, 0, 101)
  ])
  const byCost = await sb.fanout(all(sb))
  expect(candKeys(byCost.stdout).filter((k) => k === 'fake/f1-a' || k === 'fake/f1-b')[0]).toBe('fake/f1-b')
}, 30000)

test('the pair is per task kind', async () => {
  const sb = sandbox()
  seedAll(sb, BENCH, judgedLines('fake/f1-b', 'edit', 20, 20))
  const ignored = await sb.fanout(all(sb))
  expect(candKeys(ignored.stdout).filter((k) => ['fake/f1-a', 'fake/f1-b', 'fake2/f1-c'].includes(k))[0]).toBe(
    'fake/f1-a'
  )
  const honoured = await sb.fanout(all(sb, ['--tier', '1']).flatMap((a) => (a === 'transcribe' ? ['edit'] : [a])))
  expect(candKeys(honoured.stdout).filter((k) => ['fake/f1-a', 'fake/f1-b', 'fake2/f1-c'].includes(k))[0]).toBe(
    'fake/f1-b'
  )
}, 30000)

test('a job judged twice counts once, by its last line', async () => {
  const sb = sandbox()
  const lines = judgedLines('fake/f1-b', 'transcribe', 19, 19)
  lines.push({ kind: 'judged', key: 'fake/f1-b', job: 'J1', task_kind: 'transcribe', accepted: false, cost_usd: 0 })
  lines.push({ kind: 'judged', key: 'fake/f1-b', job: 'J1', task_kind: 'transcribe', accepted: true, cost_usd: 0 })
  seedAll(sb, BENCH, lines)
  const tied = await sb.fanout(all(sb))
  expect(candKeys(tied.stdout).filter((k) => ['fake/f1-a', 'fake/f1-b', 'fake2/f1-c'].includes(k))[0]).toBe('fake/f1-a')

  seedAll(sb, BENCH, [...lines, ...judgedLines('fake/f1-b', 'transcribe', 1, 1, 0, 101)])
  const scored = await sb.fanout(all(sb))
  expect(candKeys(scored.stdout).filter((k) => ['fake/f1-a', 'fake/f1-b', 'fake2/f1-c'].includes(k))[0]).toBe(
    'fake/f1-b'
  )
}, 30000)

test('tier and billing still dominate', async () => {
  const sb = sandbox()
  seedAll(sb, BENCH, judgedLines('fake/f2-a', 'transcribe', 20, 20))
  const r = await sb.fanout(all(sb))
  expect(r.code).toBe(0)
  const order = candKeys(r.stdout)
  const tier1 = ['fake/f1-a', 'fake/f1-b', 'fake2/f1-c'].map((k) => order.indexOf(k))
  expect(Math.max(...tier1)).toBeLessThan(order.indexOf('fake/f2-a'))
}, 30000)

test('the harness preference still comes first', async () => {
  const sb = sandbox()
  seedAll(sb, BENCH, judgedLines('fake/f1-b', 'transcribe', 20, 20))
  const r = await sb.fanout(all(sb, ['--harness', 'fake2']))
  expect(r.code).toBe(0)
  expect(candKeys(r.stdout)[0]).toBe('fake2/f1-c')
}, 30000)
