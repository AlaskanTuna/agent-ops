import { test, expect } from 'bun:test'
import { appendFileSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sandbox } from './helpers/sandbox'

const HEADER =
  'harness\tmodel\tkind\tjobs\tok\taccepted\trejected\tsuccess_rate\tfallbacks_from\tcost_usd\tcost_mc\tcalls\tcost_per_accepted_usd'

function runArgs(sb: ReturnType<typeof sandbox>, brief?: string, kind = 'transcribe') {
  return [
    'run',
    '--brief',
    brief ?? sb.brief('Rename foo to bar in a.txt, nothing else.'),
    '--dir',
    sb.repo,
    '--kind',
    kind
  ]
}

function parseTable(stdout: string) {
  const lines = stdout.trim().split('\n')
  const rows = lines.slice(1).map((l) => {
    const [
      harness,
      model,
      kind,
      jobs,
      ok,
      accepted,
      rejected,
      success_rate,
      fallbacks_from,
      cost_usd,
      cost_mc,
      calls,
      cost_per_accepted_usd
    ] = l.split('\t')
    return {
      harness,
      model,
      kind,
      jobs,
      ok,
      accepted,
      rejected,
      success_rate,
      fallbacks_from,
      cost_usd,
      cost_mc,
      calls,
      cost_per_accepted_usd
    }
  })
  return { header: lines[0], rows }
}

function starts(sb: ReturnType<typeof sandbox>) {
  return sb.ledger().filter((e) => e.event === 'job_start')
}

test('one accepted and one rejected job', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  await sb.fanout(runArgs(sb))
  const idA = starts(sb).at(-1)!.job as string
  await sb.fanout(runArgs(sb))
  const idB = starts(sb).at(-1)!.job as string
  const c1 = '01KAAAAAAAAC10000000000001'
  const c2 = '01KAAAAAAAAC20000000000002'
  const root = '01KAAAAAAAAR30000000000003'
  sb.seed([
    { ts: '2026-11-15T01:00:00.000Z', event: 'verdict', job: idA, accepted: true },
    { ts: '2026-11-15T01:00:00.000Z', event: 'verdict', job: idB, accepted: false },
    {
      ts: '2026-11-15T01:00:00.000Z',
      event: 'job_start',
      job: c1,
      root,
      harness: 'fake',
      model: 'f1-a',
      effort: 'medium',
      tier: 1,
      kind: 'transcribe',
      data_class: 'private',
      attempt: 1,
      reason: 'initial',
      billing: 'subscription',
      brief_sha: '0'.repeat(64),
      caller: 'test',
      repo: 'repo'
    },
    {
      ts: '2026-11-15T01:00:00.000Z',
      event: 'job_end',
      job: c1,
      root,
      harness: 'fake',
      model: 'f1-a',
      outcome: 'rate_limited',
      exit: 1,
      duration_s: 1,
      cost_source: 'unknown',
      caller: 'test',
      repo: 'repo'
    },
    {
      ts: '2026-11-15T01:00:00.000Z',
      event: 'job_start',
      job: c2,
      root,
      harness: 'fake',
      model: 'f1-b',
      effort: 'medium',
      tier: 1,
      kind: 'transcribe',
      data_class: 'private',
      attempt: 2,
      reason: 'fallback',
      from_job: c1,
      billing: 'subscription',
      brief_sha: '0'.repeat(64),
      caller: 'test',
      repo: 'repo'
    },
    {
      ts: '2026-11-15T01:00:00.000Z',
      event: 'job_end',
      job: c2,
      root,
      harness: 'fake',
      model: 'f1-b',
      outcome: 'ok',
      exit: 0,
      duration_s: 1,
      tokens_in: 1000,
      tokens_out: 200,
      tokens_cached: 0,
      cost_source: 'computed',
      caller: 'test',
      repo: 'repo'
    }
  ])
  const r = await sb.fanout(['report'])
  expect(r.code).toBe(0)
  const { header, rows } = parseTable(r.stdout)
  expect(header).toBe(HEADER)
  const row = rows.find((x) => x.harness === 'fake' && x.model === 'f1-a' && x.kind === 'transcribe')
  expect(row).toMatchObject({
    jobs: '3',
    ok: '2',
    accepted: '1',
    rejected: '1',
    success_rate: '0.5',
    fallbacks_from: '1'
  })
})

test('cost per accepted job', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate('harness,model,status\nfake,*,retired\nfake2,f1-c,retired\nfake3,*,retired\n')
  await sb.fanout(runArgs(sb))
  const [s] = starts(sb)
  expect(s).toMatchObject({ harness: 'fake2', model: 'f1-paid' })
  sb.seed([{ ts: '2026-11-15T01:00:00.000Z', event: 'verdict', job: s.job, accepted: true }])
  const r = await sb.fanout(['report'])
  expect(r.code).toBe(0)
  const { rows } = parseTable(r.stdout)
  const row = rows.find((x) => x.harness === 'fake2' && x.model === 'f1-paid' && x.kind === 'transcribe')
  expect(row).toMatchObject({ cost_usd: '0.0014', cost_per_accepted_usd: '0.0014' })
  const total = rows.find((x) => x.harness === 'TOTAL')
  expect(total).toMatchObject({ cost_usd: '0.0014' })
})

test('a corrupt line and a v2 event do not break the report', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  await sb.fanout(runArgs(sb))
  appendFileSync(join(sb.home, 'events', '2026-11.jsonl'), '{not json\n')
  appendFileSync(
    join(sb.home, 'events', '2026-11.jsonl'),
    JSON.stringify({ v: 2, ts: '2026-11-15T01:00:00.000Z', event: 'job_start', job: 'ZZZ' }) + '\n'
  )
  const r = await sb.fanout(['report'])
  expect(r.code).toBe(0)
  const { rows } = parseTable(r.stdout)
  const row = rows.find((x) => x.harness === 'fake' && x.model === 'f1-a' && x.kind === 'transcribe')
  expect(row).toMatchObject({ jobs: '1', ok: '1' })
})

test('--since excludes older events', async () => {
  const sb = sandbox()
  const mk = (job: string, ts: string) => [
    {
      ts,
      event: 'job_start',
      job,
      root: job,
      harness: 'fake',
      model: 'f1-a',
      effort: 'medium',
      tier: 1,
      kind: 'transcribe',
      data_class: 'private',
      attempt: 1,
      reason: 'initial',
      billing: 'subscription',
      brief_sha: '0'.repeat(64),
      caller: 'test',
      repo: 'repo'
    },
    {
      ts,
      event: 'job_end',
      job,
      root: job,
      harness: 'fake',
      model: 'f1-a',
      outcome: 'ok',
      exit: 0,
      duration_s: 1,
      cost_source: 'unknown',
      caller: 'test',
      repo: 'repo'
    }
  ]
  sb.seed([
    ...mk('01KAAAAAAAAOLD000000000001', '2026-11-10T01:00:00.000Z'),
    ...mk('01KAAAAAAAANEW000000000002', '2026-11-15T01:00:00.000Z')
  ])
  const r = await sb.at('2026-11-15T02:00:00Z').fanout(['report', '--since', '1d'])
  expect(r.code).toBe(0)
  const { rows } = parseTable(r.stdout)
  const row = rows.find((x) => x.harness === 'fake' && x.model === 'f1-a' && x.kind === 'transcribe')
  expect(row).toMatchObject({ jobs: '1' })
})

test('no duckdb: exit 1 with the message, and run still works', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  // A minimal PATH with only bun: duckdb is absent, so the report must fail
  // without touching the ledger. (pathWithout scans the whole machine PATH,
  // which takes ~50 s here.)
  const dir = mkdtempSync(join(tmpdir(), 'fanout-no-duckdb-'))
  symlinkSync(process.execPath, join(dir, 'bun'))
  const r = await sb.fanout(['report'], { env: { PATH: dir } })
  expect(r.code).toBe(1)
  expect(r.stderr).toContain('duckdb not found; reports are unavailable (the ledger and run are unaffected)')
  const run = await sb.fanout(runArgs(sb))
  expect(run.code).toBe(0)
})

test('an empty ledger prints the header and a zero TOTAL row', async () => {
  const sb = sandbox()
  const r = await sb.fanout(['report'])
  expect(r.code).toBe(0)
  const { header, rows } = parseTable(r.stdout)
  expect(header).toBe(HEADER)
  const total = rows.find((x) => x.harness === 'TOTAL')
  expect(total).toMatchObject({ jobs: '0' })
})
