import { test, expect } from 'bun:test'
import { sandbox } from './helpers/sandbox'

const BASE = '2026-11-15T01:00:00Z'
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

function patternsDoc(sb: ReturnType<typeof sandbox>): { rules: Record<string, unknown>[] } {
  const lines = sb.learned('patterns.json') as { rules?: Record<string, unknown>[] }[]
  return { rules: lines.flatMap((l) => l.rules ?? []) }
}

async function patternsOnly(sb: ReturnType<typeof sandbox>) {
  return sb.fanout(['upkeep', '--only', 'patterns'])
}

test('three matches across two chains are learned', async () => {
  const sb = sandbox().at(BASE)
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['unknown_error', 'unknown_error'] })
  await sb.fanout(runArgs(sb))
  sb.at('2026-11-15T02:00:00Z')
  sb.script({ 'fake/f1-a': ['unknown_error', 'ok'] })
  await sb.fanout(runArgs(sb))
  const u = await patternsOnly(sb)
  expect(u.code).toBe(0)
  const learned = sb.ledger().filter((e) => e.event === 'pattern_learned')
  expect(learned).toHaveLength(1)
  expect(learned[0]).toMatchObject({ harness: 'fake', outcome: 'worker_error' })
  const re = new RegExp(String(learned[0].regex))
  expect(re.test('kaboom 99')).toBe(true)
  expect(re.test('kaboom')).toBe(false)
  const rules = patternsDoc(sb).rules
  expect(rules).toHaveLength(1)
  expect(String(rules[0].id)).toMatch(/^learned-/)
}, 60000)

test('two chains are required', async () => {
  const sb = sandbox().at(BASE)
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['unknown_error', 'unknown_error'], 'fake/f1-b': ['unknown_error', 'unknown_error'] })
  await sb.fanout(runArgs(sb))
  await patternsOnly(sb)
  expect(sb.ledger().some((e) => e.event === 'pattern_learned')).toBe(false)
}, 60000)

test('fewer than three matches are not learned', async () => {
  const sb = sandbox().at(BASE)
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['unknown_error', 'unknown_error'] })
  await sb.fanout(runArgs(sb))
  await patternsOnly(sb)
  expect(sb.ledger().some((e) => e.event === 'pattern_learned')).toBe(false)
}, 60000)

test('the denylist is skipped', async () => {
  const sb = sandbox().at(BASE)
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['custom_error', 'custom_error'] })
  await sb.fanout(runArgs(sb), { env: { FAKE_STDERR: 'kaboom 43\n[claude-code:unrecognized_model]' } })
  sb.at('2026-11-15T02:00:00Z')
  sb.script({ 'fake/f1-a': ['custom_error', 'ok'] })
  await sb.fanout(runArgs(sb), { env: { FAKE_STDERR: 'kaboom 43\n[claude-code:unrecognized_model]' } })
  await patternsOnly(sb)
  const learned = sb.ledger().filter((e) => e.event === 'pattern_learned')
  expect(learned).toHaveLength(1)
  const re = new RegExp(String(learned[0].regex))
  expect(re.test('kaboom 7')).toBe(true)
  expect(re.test('unrecognized_model')).toBe(false)
}, 60000)

test('a fully denied signature learns nothing', async () => {
  const sb = sandbox().at(BASE)
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['custom_error', 'custom_error'] })
  await sb.fanout(runArgs(sb), { env: { FAKE_STDERR: '[claude-code:unrecognized_model]' } })
  sb.at('2026-11-15T02:00:00Z')
  sb.script({ 'fake/f1-a': ['custom_error', 'ok'] })
  await sb.fanout(runArgs(sb), { env: { FAKE_STDERR: '[claude-code:unrecognized_model]' } })
  await patternsOnly(sb)
  expect(sb.ledger().some((e) => e.event === 'pattern_learned')).toBe(false)
}, 60000)

test('running the step again learns nothing new', async () => {
  const sb = sandbox().at(BASE)
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['unknown_error', 'unknown_error'] })
  await sb.fanout(runArgs(sb))
  sb.at('2026-11-15T02:00:00Z')
  sb.script({ 'fake/f1-a': ['unknown_error', 'ok'] })
  await sb.fanout(runArgs(sb))
  await patternsOnly(sb)
  await patternsOnly(sb)
  expect(sb.ledger().filter((e) => e.event === 'pattern_learned')).toHaveLength(1)
  expect(patternsDoc(sb).rules).toHaveLength(1)
}, 60000)

test('after learning, the error is a worker error', async () => {
  const sb = sandbox().at(BASE)
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['unknown_error', 'unknown_error'] })
  await sb.fanout(runArgs(sb))
  sb.at('2026-11-15T02:00:00Z')
  sb.script({ 'fake/f1-a': ['unknown_error', 'ok'] })
  await sb.fanout(runArgs(sb))
  await patternsOnly(sb)
  const id = String(patternsDoc(sb).rules[0].id)
  sb.script({ 'fake/f1-a': ['unknown_error'] })
  const r = await sb.fanout(runArgs(sb))
  expect(r.code).toBe(0)
  expect(r.stdout).not.toContain('RETRY')
  const m = /^FANOUT job=(\w{26}) /m.exec(r.stdout)
  expect(m).not.toBeNull()
  const start = sb.ledger().find((e) => e.event === 'job_start' && e.job === m![1])
  const root = String(start?.root ?? m![1])
  const end = sb.ledger().find((e) => e.event === 'job_end' && e.outcome === 'worker_error' && e.root === root)
  expect(end).toMatchObject({ pattern: id })
  expect(sb.ledger().filter((e) => e.event === 'limit_hit' && e.source === 'backoff' && e.root === root)).toHaveLength(
    1
  )
  expect(r.stdout).toContain('FALLBACK fake/f1-a worker_error -> fake/f1-b')
}, 60000)

test('a learned rule never outranks a built-in rule', async () => {
  const sb = sandbox().at(BASE)
  sb.catalogPrivate(NO_PAID)
  sb.seedLearned('patterns.json', [
    {
      rules: [
        {
          id: 'learned-x',
          harness: 'fake',
          re: 'HTTP 429',
          outcome: 'worker_error',
          adopted_at: '2026-11-15T00:00:00.000Z',
          last_match: '2026-11-15T00:00:00.000Z'
        }
      ]
    }
  ])
  sb.script({ 'fake/f1-a': ['rate_limited'] })
  const r = await sb.fanout(runArgs(sb))
  expect(r.code).toBe(0)
  const end = sb.ledger().find((e) => e.event === 'job_end' && e.harness === 'fake' && e.model === 'f1-a')
  expect(end).toMatchObject({ outcome: 'rate_limited', pattern: 'gen-429' })
}, 60000)

test('learned rules are per harness', async () => {
  const sb = sandbox().at(BASE)
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['unknown_error', 'unknown_error'] })
  await sb.fanout(runArgs(sb))
  sb.at('2026-11-15T02:00:00Z')
  sb.script({ 'fake/f1-a': ['unknown_error', 'ok'] })
  await sb.fanout(runArgs(sb))
  await patternsOnly(sb)
  sb.catalogPrivate('harness,model,status\nfake,*,retired\n' + NO_PAID.split('\n').slice(1).join('\n'))
  sb.script({ 'fake2/f1-c': ['unknown_error'] })
  const r = await sb.fanout(runArgs(sb))
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('RETRY')
  const end = sb.ledger().find((e) => e.event === 'job_end' && e.harness === 'fake2')
  expect(end).toMatchObject({ outcome: 'unknown' })
}, 60000)

test('rules expire after 60 days without a match', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  const ago = (days: number): string =>
    new Date(Date.parse('2026-11-15T01:00:00Z') - days * 24 * 3600 * 1000).toISOString()
  sb.seedLearned('patterns.json', [
    {
      rules: [
        {
          id: 'learned-old',
          harness: 'fake',
          re: 'kaboom \\d+',
          outcome: 'worker_error',
          adopted_at: ago(61),
          last_match: ago(61)
        },
        {
          id: 'learned-mid',
          harness: 'fake',
          re: 'bang \\d+',
          outcome: 'worker_error',
          adopted_at: ago(59),
          last_match: ago(59)
        },
        {
          id: 'learned-new',
          harness: 'fake',
          re: 'wham \\d+',
          outcome: 'worker_error',
          adopted_at: ago(1),
          last_match: ago(1)
        }
      ]
    }
  ])
  await patternsOnly(sb)
  const ids = patternsDoc(sb)
    .rules.map((r) => r.id)
    .sort()
  expect(ids).toEqual(['learned-mid', 'learned-new'])
  const expired = sb.ledger().filter((e) => e.event === 'pattern_expired')
  expect(expired).toHaveLength(1)
  expect(expired[0]).toMatchObject({ id: 'learned-old' })
}, 30000)

test('a recent match keeps a rule alive', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  const ago = (days: number): string =>
    new Date(Date.parse('2026-11-15T01:00:00Z') - days * 24 * 3600 * 1000).toISOString()
  sb.seedLearned('patterns.json', [
    {
      rules: [
        {
          id: 'learned-keep',
          harness: 'fake',
          re: 'kaboom \\d+',
          outcome: 'worker_error',
          adopted_at: ago(90),
          last_match: ago(90)
        }
      ]
    }
  ])
  sb.seed([
    {
      ts: ago(2),
      event: 'job_end',
      job: '01JZZZZZZZZZZZZZZZZZZZZZZZZ',
      root: '01JZZZZZZZZZZZZZZZZZZZZZZZZ',
      harness: 'fake',
      model: 'f1-a',
      outcome: 'worker_error',
      pattern: 'learned-keep'
    }
  ])
  await patternsOnly(sb)
  expect(patternsDoc(sb).rules.map((r) => r.id)).toEqual(['learned-keep'])
  expect(sb.ledger().some((e) => e.event === 'pattern_expired')).toBe(false)
}, 30000)
