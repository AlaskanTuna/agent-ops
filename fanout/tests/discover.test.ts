import { test, expect } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { sandbox } from './helpers/sandbox'

const BASE = '2026-11-15T01:00:00Z'

function autoRows(sb: ReturnType<typeof sandbox>): Record<string, unknown>[] {
  const lines = sb.learned('catalog.auto.json') as { rows?: Record<string, unknown>[] }[]
  return lines.flatMap((l) => l.rows ?? [])
}

function autoFor(sb: ReturnType<typeof sandbox>, key: string): Record<string, unknown> | undefined {
  return autoRows(sb).find((r) => `${r.harness}/${r.model}` === key)
}

async function discover(sb: ReturnType<typeof sandbox>, extraEnv: Record<string, string | undefined> = {}) {
  return sb.fanout(['upkeep', '--only', 'discover'], { env: extraEnv })
}

test('a new model becomes an auto trial row', async () => {
  const sb = sandbox().at(BASE)
  const r = await discover(sb, {
    FANOUT_FAKE_MODELS: JSON.stringify({
      fake: [
        { model: 'f1-a' },
        { model: 'f1-b' },
        { model: 'f2-a' },
        { model: 'f3-z' },
        { model: 'f9-new', billing: 'subscription' }
      ],
      fake2: [{ model: 'f1-c' }, { model: 'f2-b' }],
      fake3: [{ model: 'f3-a' }]
    })
  })
  expect(r.code).toBe(0)
  expect(autoFor(sb, 'fake/f9-new')).toMatchObject({ status: 'trial', billing: 'subscription' })
  expect(sb.ledger().some((e) => e.event === 'model_seen' && e.harness === 'fake' && e.model === 'f9-new')).toBe(true)
  expect(sb.ledger().some((e) => e.event === 'tier_set' && e.model === 'f9-new' && e.source === 'auto')).toBe(true)
  const pick = await sb.fanout(['pick', '--all', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'transcribe'])
  expect(pick.stdout).not.toContain('f9-new')
}, 30000)

test('the default and private catalogs win over discovery', async () => {
  const sb = sandbox().at(BASE)
  sb.catalog(sb.fixtureCatalog() + 'agy,gemini-4-argon,medium|high,1,subscription,,,,,0,any,active,argon,,,,\n')
  sb.catalogPrivate('harness,model,tier\nagy,gemini-4-argon,3\n')
  sb.bin('agy', '#!/bin/sh\necho "gemini-4-argon-medium gemini-4-argon-high"\n')
  const r = await discover(sb)
  expect(r.code).toBe(0)
  expect(autoFor(sb, 'agy/gemini-4-argon')).toBeUndefined()
  const pick = await sb.fanout(['pick', '--all', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'transcribe'])
  expect(pick.stdout).toContain('agy/gemini-4-argon tier=3')
}, 30000)

test('ignored ids are never added', async () => {
  const sb = sandbox().at(BASE)
  sb.catalog(sb.fixtureCatalog() + 'agy,gemini-4-argon,medium|high,1,subscription,,,,,0,any,active,argon,,,,\n')
  sb.bin('agy', '#!/bin/sh\necho "gemini-4-argon-medium claude-sonnet-5-5-low"\n')
  const r = await discover(sb)
  expect(r.code).toBe(0)
  expect(autoRows(sb).some((row) => String(row.model).includes('sonnet'))).toBe(false)
}, 30000)

test('a missing model is gone, and the memory survives the window', async () => {
  const sb = sandbox().at(BASE)
  sb.catalogPrivate('harness,model,status\nfake2,*,retired\nfake3,*,retired\n')
  await discover(sb, {
    FANOUT_FAKE_MODELS: JSON.stringify({ fake: [{ model: 'f1-b' }, { model: 'f2-a' }, { model: 'f3-z' }] })
  })
  expect(sb.learned('state.jsonl').some((l) => l.kind === 'gone' && l.key === 'fake/f1-a')).toBe(true)
  rmSync(join(sb.home, 'events'), { recursive: true, force: true })
  const pick = await sb.fanout(['pick', '--all', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'transcribe'])
  expect(pick.code).toBe(0)
  expect(pick.stdout).not.toContain('fake/f1-a')
  const full = await sb.fanout(['status'])
  expect(full.stdout).toContain('gone')
}, 30000)

test('status shows new and gone models', async () => {
  const sb = sandbox().at(BASE)
  sb.catalogPrivate('harness,model,status\nfake2,*,retired\nfake3,*,retired\n')
  const models = {
    fake: [{ model: 'f1-b' }, { model: 'f2-a' }, { model: 'f3-z' }, { model: 'f9-new', billing: 'subscription' }]
  }
  await discover(sb, { FANOUT_FAKE_MODELS: JSON.stringify(models) })
  const s = await sb.fanout(['status', '--brief'])
  expect(s.stdout).toContain('NEW fake/f9-new')
  expect(s.stdout).toContain('GONE fake/f1-a')
}, 30000)

test('a failed listing changes nothing', async () => {
  const sb = sandbox().at(BASE)
  const r = await discover(sb, { FANOUT_FAKE_MODELS: 'not json' })
  expect(r.code).toBe(0)
  const events = sb.ledger().filter((e) => e.event === 'upkeep')
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ step: 'discover', status: 'failed' })
  expect(sb.learned('state.jsonl').some((l) => l.kind === 'gone')).toBe(false)
  expect(autoRows(sb)).toHaveLength(0)
}, 30000)

test('a returning model is revived', async () => {
  const sb = sandbox().at(BASE)
  sb.catalogPrivate('harness,model,status\nfake2,*,retired\nfake3,*,retired\n')
  await discover(sb, {
    FANOUT_FAKE_MODELS: JSON.stringify({ fake: [{ model: 'f1-b' }] })
  })
  expect(sb.learned('state.jsonl').some((l) => l.kind === 'gone' && l.key === 'fake/f1-a')).toBe(true)
  await discover(sb, {
    FANOUT_FAKE_MODELS: JSON.stringify({ fake: [{ model: 'f1-a' }, { model: 'f1-b' }] })
  })
  const lines = sb.learned('state.jsonl').filter((l) => l.key === 'fake/f1-a')
  expect(lines[lines.length - 1]).toMatchObject({ kind: 'back' })
  const pick = await sb.fanout(['pick', '--all', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'transcribe'])
  expect(pick.stdout).toContain('fake/f1-a')
}, 30000)

test('auto tier from benchmarks and price', async () => {
  const sb = sandbox().at(BASE)
  sb.catalogPrivate('harness,model,status\nfake2,*,retired\nfake3,*,retired\n')
  sb.seedLearned('benchmarks.json', [
    {
      models: [
        { name: 'f9-b30', aa_intel: 30 },
        { name: 'f9-b50', aa_intel: 50 },
        { name: 'f9-b55', aa_intel: 55 }
      ]
    }
  ])
  await discover(sb, {
    FANOUT_FAKE_MODELS: JSON.stringify({
      fake: [
        { model: 'f1-a' },
        { model: 'f1-b' },
        { model: 'f2-a' },
        { model: 'f3-z' },
        { model: 'f9-b30' },
        { model: 'f9-b50' },
        { model: 'f9-b55' },
        { model: 'f9-p04', price_out: 0.4 },
        { model: 'f9-p05', price_out: 5 },
        { model: 'f9-pnn' }
      ]
    })
  })
  const tier = (m: string): unknown => String(autoFor(sb, `fake/${m}`)?.tier)
  expect([tier('f9-b30'), tier('f9-b50'), tier('f9-b55'), tier('f9-p04'), tier('f9-p05'), tier('f9-pnn')]).toEqual([
    '1',
    '2',
    '3',
    '1',
    '2',
    '2'
  ])
}, 30000)

test('normalize matches names to aliases', async () => {
  const sb = sandbox().at(BASE)
  sb.catalogPrivate('harness,model,status\nfake2,*,retired\nfake3,*,retired\n')
  sb.seedLearned('benchmarks.json', [{ models: [{ name: 'Qwen3.8 27B', aa_intel: 40 }] }])
  await discover(sb, {
    FANOUT_FAKE_MODELS: JSON.stringify({
      fake: [{ model: 'f1-a' }, { model: 'f1-b' }, { model: 'f2-a' }, { model: 'f3-z' }, { model: 'Qwen/Qwen3.8-27B' }]
    })
  })
  expect(String(autoFor(sb, 'fake/Qwen/Qwen3.8-27B')?.tier)).toBe('2')
}, 30000)

test('public-only by name', async () => {
  const sb = sandbox().at(BASE)
  sb.catalogPrivate('harness,model,status\nfake2,*,retired\nfake3,*,retired\n')
  await discover(sb, {
    FANOUT_FAKE_MODELS: JSON.stringify({
      fake: [
        { model: 'f1-a' },
        { model: 'f1-b' },
        { model: 'f2-a' },
        { model: 'f3-z' },
        { model: 'muse-x-contributor' },
        { model: 'stealth/alpha' },
        { model: 'acme/model:free' },
        { model: 'ok-model' }
      ]
    })
  })
  const cls = (m: string): unknown => autoFor(sb, `fake/${m}`)?.data_class
  expect([cls('muse-x-contributor'), cls('stealth/alpha'), cls('acme/model:free'), cls('ok-model')]).toEqual([
    'public-only',
    'public-only',
    'public-only',
    'any'
  ])
}, 30000)

test('a paid model without a price stays unrouted', async () => {
  const sb = sandbox().at(BASE)
  sb.catalogPrivate('harness,model,status\nfake2,*,retired\nfake3,*,retired\n')
  await discover(sb, {
    FANOUT_FAKE_MODELS: JSON.stringify({
      fake: [
        { model: 'f1-a' },
        { model: 'f1-b' },
        { model: 'f2-a' },
        { model: 'f3-z' },
        { model: 'f9-unpriced', billing: 'paid' }
      ]
    })
  })
  const row = autoFor(sb, 'fake/f9-unpriced')
  expect(row).toMatchObject({ billing: 'paid' })
  expect(row?.price_in ?? '').toBe('')
  const pick = await sb.fanout(['pick', '--all', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'transcribe'])
  expect(pick.code).toBe(0)
  expect(pick.stdout).not.toContain('f9-unpriced')
  expect(pick.stderr).not.toContain('WARN catalog row skipped')
}, 30000)

test('running discover twice adds nothing', async () => {
  const sb = sandbox().at(BASE)
  sb.catalogPrivate('harness,model,status\nfake2,*,retired\nfake3,*,retired\n')
  const env = {
    FANOUT_FAKE_MODELS: JSON.stringify({
      fake: [{ model: 'f1-a' }, { model: 'f1-b' }, { model: 'f2-a' }, { model: 'f3-z' }, { model: 'f9-new' }]
    })
  }
  await discover(sb, env)
  const r = await discover(sb, env)
  expect(r.code).toBe(0)
  const events = sb.ledger().filter((e) => e.event === 'upkeep')
  expect(events[events.length - 1]).toMatchObject({ step: 'discover', status: 'ok' })
  expect(String(events[events.length - 1].detail)).toContain('0 new, 0 gone')
  expect(sb.ledger().filter((e) => e.event === 'model_seen')).toHaveLength(1)
}, 30000)

test('captured listings parse', async () => {
  const sb = sandbox().at(BASE)
  sb.catalog(
    sb.fixtureCatalog() +
      'codex,codex-old,,2,subscription,,,,,0,any,active,codex-old,,,,,\n' +
      'agy,agy-old,medium|low,2,subscription,,,,,0,any,active,agy-old,,,,,\n' +
      'meta,muse-old-1.0,medium,2,paid,1.00,0.10,2.00,,0,any,active,muse-old,,,,,\n'
  )
  sb.bin('codex', '#!/bin/sh\necho \'{"models":[{"slug":"gpt-6.1-sol"}]}\'\n')
  sb.bin('agy', '#!/bin/sh\necho "gemini-4-hydrogen-medium gemini-4-hydrogen-high"\n')
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        data: [{ id: 'muse-wonder-2.0', price_in: 1, price_cached: 0.1, price_out: 2, efforts: ['medium'] }]
      })
  })
  try {
    const r = await discover(sb, {
      META_MODEL_API_KEY: 'test-key',
      FANOUT_META_URL: `http://127.0.0.1:${server.port}`
    })
    expect(r.code).toBe(0)
    expect(autoFor(sb, 'codex/gpt-6.1-sol')).toMatchObject({ billing: 'subscription', status: 'trial' })
    const hydrogen = autoFor(sb, 'agy/gemini-4-hydrogen')
    expect(hydrogen).toMatchObject({ billing: 'subscription', status: 'trial' })
    expect(String(hydrogen?.efforts).split('|').sort()).toEqual(['high', 'medium'])
    expect(autoFor(sb, 'meta/muse-wonder-2.0')).toMatchObject({ billing: 'paid' })
    expect(String(autoFor(sb, 'meta/muse-wonder-2.0')?.tier)).toBe('2')
    expect(sb.learned('state.jsonl').some((l) => l.kind === 'gone' && l.key === 'codex/codex-old')).toBe(true)
  } finally {
    server.stop()
  }
}, 60000)
