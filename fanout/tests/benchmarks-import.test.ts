import { test, expect } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { sandbox } from './helpers/sandbox'

function importCsv(sb: ReturnType<typeof sandbox>, body: string): string {
  const p = join(sb.home, 'bench.csv')
  writeFileSync(p, body)
  return p
}

function seedBench(sb: ReturnType<typeof sandbox>, values: Record<string, Record<string, unknown>>): void {
  mkdirSync(join(sb.home, 'learned'), { recursive: true })
  writeFileSync(join(sb.home, 'learned', 'benchmarks.json'), JSON.stringify({ values }))
}

function learnedValues(sb: ReturnType<typeof sandbox>): Record<string, any> {
  return (JSON.parse(readFileSync(join(sb.home, 'learned', 'benchmarks.json'), 'utf8')) as any).values as Record<
    string,
    any
  >
}

function candOrder(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter((l) => l.startsWith('CAND '))
    .map((l) => l.split(' ')[2] ?? '')
}

test('a good import', async () => {
  const sb = sandbox()
  const csv = importCsv(
    sb,
    'name,metric,value,as_of\nf1-a,arena_webdev,1600,2026-11-15\nF1-B,frontiercode2,30,2026-11-15\nghost,arena_webdev,1500,2026-11-15\n'
  )
  const r = await sb.fanout(['benchmarks', 'import', csv])
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('UNMATCHED ghost')
  expect(r.stdout).toContain('IMPORTED 2 values for 2 models; skipped 0')
  const events = sb.ledger().filter((e) => e.event === 'benchmark')
  expect(events).toHaveLength(2)
  expect(events.every((e) => e.source === 'import')).toBe(true)
  expect(learnedValues(sb)['fake/f1-a']).toMatchObject({ arena_webdev: 1600 })
  expect(learnedValues(sb)['fake/f1-b']).toMatchObject({ frontiercode2: 30 })
}, 30000)

test('bad rows are skipped with a reason', async () => {
  const sb = sandbox()
  const csv = importCsv(
    sb,
    'name,metric,value,as_of\nf1-a,arena_webdev,5000,2026-11-15\nf1-b,frontiercode2,120,2026-11-15\n'
  )
  const r = await sb.fanout(['benchmarks', 'import', csv])
  expect(r.code).toBe(1)
  expect(r.stdout).toContain('SKIPPED row 1: arena_webdev must be 800 to 2500')
  expect(r.stdout).toContain('SKIPPED row 2: frontiercode2 must be 0 to 100')
  expect(r.stdout).toContain('IMPORTED 0 values for 0 models; skipped 2')
  expect(sb.ledger().filter((e) => e.event === 'benchmark')).toHaveLength(0)
}, 30000)

test('a bad header exits 2', async () => {
  const sb = sandbox()
  const csv = importCsv(sb, 'model,score\nf1-a,1600\n')
  const r = await sb.fanout(['benchmarks', 'import', csv])
  expect(r.code).toBe(2)
  expect(r.stderr).toContain('header must be name,metric,value,as_of')
}, 30000)

test('an import keeps other metrics', async () => {
  const sb = sandbox()
  seedBench(sb, { 'fake/f1-a': { aa_intel: 30 } })
  const csv = importCsv(sb, 'name,metric,value,as_of\nf1-a,arena_webdev,1600,2026-11-15\n')
  const r = await sb.fanout(['benchmarks', 'import', csv])
  expect(r.code).toBe(0)
  expect(learnedValues(sb)['fake/f1-a']).toMatchObject({ aa_intel: 30, arena_webdev: 1600 })
}, 30000)

test('ranking uses the metrics every scored row shares', async () => {
  const sb = sandbox()
  seedBench(sb, {
    'fake/f1-a': { aa_intel: 30, arena_webdev: 1600 },
    'fake/f1-b': { aa_intel: 40, arena_webdev: 1500 },
    'fake2/f1-c': { aa_intel: 35 }
  })
  const r = await sb.fanout(['pick', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'transcribe', '--all'])
  expect(r.code).toBe(0)
  const order = candOrder(r.stdout).filter((k) => ['fake/f1-a', 'fake/f1-b', 'fake2/f1-c'].includes(k))
  expect(order).toEqual(['fake/f1-b', 'fake2/f1-c', 'fake/f1-a'])
}, 30000)

test('rows without data rank after rows with data', async () => {
  const sb = sandbox()
  seedBench(sb, { 'fake/f1-b': { aa_intel: 40 } })
  const r = await sb.fanout(['pick', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'transcribe', '--all'])
  expect(r.code).toBe(0)
  const order = candOrder(r.stdout).filter((k) => ['fake/f1-a', 'fake/f1-b', 'fake2/f1-c'].includes(k))
  expect(order).toEqual(['fake/f1-b', 'fake/f1-a', 'fake2/f1-c'])
}, 30000)

test('an empty shared set ties every row', async () => {
  const sb = sandbox()
  seedBench(sb, { 'fake/f1-a': { aa_intel: 30 }, 'fake/f1-b': { arena_webdev: 1600 } })
  const r = await sb.fanout(['pick', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'transcribe', '--all'])
  expect(r.code).toBe(0)
  const order = candOrder(r.stdout).filter((k) => ['fake/f1-a', 'fake/f1-b', 'fake2/f1-c'].includes(k))
  expect(order).toEqual(['fake/f1-a', 'fake/f1-b', 'fake2/f1-c'])
}, 30000)

test('benchmarks never beat tier or billing', async () => {
  const sb = sandbox()
  seedBench(sb, {
    'fake/f1-a': { aa_intel: 20 },
    'fake/f1-b': { aa_intel: 20 },
    'fake2/f1-c': { aa_intel: 20 },
    'fake3/f1-paid-b': { aa_intel: 99 }
  })
  const r = await sb.fanout(['pick', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'transcribe', '--all'])
  expect(r.code).toBe(0)
  const order = candOrder(r.stdout)
  const subs = ['fake/f1-a', 'fake/f1-b', 'fake2/f1-c'].map((k) => order.indexOf(k))
  const paid = order.indexOf('fake3/f1-paid-b')
  const tier2 = order.findIndex((k) => k === 'fake/f2-a')
  expect(Math.max(...subs)).toBeLessThan(paid)
  expect(paid).toBeLessThan(tier2)
}, 30000)

test('the learned file overrides the seed per metric', async () => {
  const sb = sandbox()
  seedBench(sb, { 'codex/gpt-6-luna': { aa_intel: 99 } })
  const r = await sb.fanout(
    ['pick', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'transcribe', '--harness', 'codex', '--all'],
    {
      noCatalog: true
    }
  )
  expect(r.code).toBe(0)
  const order = candOrder(r.stdout).filter((k) => k === 'codex/gpt-6-luna' || k === 'agy/gemini-3.8-flash')
  expect(order[0]).toBe('codex/gpt-6-luna')
}, 30000)

test('the seed is generated, not typed', () => {
  const seed = JSON.parse(readFileSync(resolve(import.meta.dir, '../catalog/benchmarks.seed.json'), 'utf8')) as Record<
    string,
    Record<string, unknown>
  >
  for (const [k, v] of Object.entries(seed)) {
    expect(k.startsWith('ref/')).toBe(false)
    for (const [metric, value] of Object.entries(v)) {
      if (metric === 'as_of') {
        expect(value).toBe('2026-11-15')
      } else {
        expect(typeof value).toBe('number')
      }
    }
  }
})
