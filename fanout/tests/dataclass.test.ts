import { test, expect } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sandbox } from './helpers/sandbox'

function base(sb: ReturnType<typeof sandbox>, extra: string[] = []) {
  return ['pick', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'transcribe', ...extra]
}

test('no remote is private', async () => {
  const s = sandbox()
  const r = await s.fanout(base(s))
  expect(r.code).toBe(0)
  expect(r.stdout.split('\n')[0]).toMatch(/ data=private$/)
})

test('an unreachable remote is private and the probe does not hang', async () => {
  const s = sandbox()
  Bun.spawnSync(['git', 'remote', 'add', 'origin', 'https://example.invalid/x.git'], { cwd: s.repo })
  const started = Date.now()
  const r = await s.fanout(base(s))
  expect(Date.now() - started).toBeLessThan(10000)
  expect(r.stdout.split('\n')[0]).toMatch(/ data=private$/)
})

test('FANOUT_PROBE forces the answer', async () => {
  const s = sandbox()
  const pub = await s.fanout(base(s, ['--all']), { env: { FANOUT_PROBE: 'public' } })
  expect(pub.stdout.split('\n')[0]).toMatch(/ data=public$/)
  expect(pub.stdout).toMatch(/fake3\/f1-pub/)
  const priv = await s.fanout(base(s, ['--all']), { env: { FANOUT_PROBE: 'private' } })
  expect(priv.stdout.split('\n')[0]).toMatch(/ data=private$/)
  expect(priv.stdout).not.toMatch(/fake3\/f1-pub/)
})

test('overrides', async () => {
  const s = sandbox()
  const priv = await s.fanout(base(s, ['--private']), { env: { FANOUT_PROBE: 'public' } })
  expect(priv.stdout.split('\n')[0]).toMatch(/ data=private$/)
  const pub = await s.fanout(base(s, ['--public']))
  expect(pub.stdout.split('\n')[0]).toMatch(/ data=public$/)
  const both = await s.fanout(base(s, ['--public', '--private']))
  expect(both.code).toBe(2)
  expect(both.stderr).toMatch(/--public and --private conflict/)
})

test('a fresh cache entry is used and a stale one is not', async () => {
  const s = sandbox().at('2026-11-15T01:00:00Z')
  Bun.spawnSync(['git', 'remote', 'add', 'origin', 'https://example.invalid/x.git'], { cwd: s.repo })
  const runDir = join(s.home, 'run')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(
    join(runDir, 'dataclass-cache.json'),
    JSON.stringify({ 'https://example.invalid/x.git': { public: true, ts: '2026-11-15T00:00:00.000Z' } })
  )
  const fresh = await s.fanout(base(s))
  expect(fresh.stdout.split('\n')[0]).toMatch(/ data=public$/)
  writeFileSync(
    join(runDir, 'dataclass-cache.json'),
    JSON.stringify({ 'https://example.invalid/x.git': { public: true, ts: '2026-11-13T00:00:00.000Z' } })
  )
  const stale = await s.fanout(base(s))
  expect(stale.stdout.split('\n')[0]).toMatch(/ data=private$/)
})

test('the upstream class is stricter than the catalog class', async () => {
  const s = sandbox()
  const r = await s.fanout(base(s, ['--all']), {
    env: { FAKE_UPSTREAM: JSON.stringify({ 'fake2/f1-c': 'meta/muse-x-contributor' }) }
  })
  expect(r.stdout).not.toMatch(/fake2\/f1-c/)
  const pub = await s.fanout(base(s, ['--all', '--public']), {
    env: { FAKE_UPSTREAM: JSON.stringify({ 'fake2/f1-c': 'meta/muse-x-contributor' }) }
  })
  expect(pub.stdout).toMatch(/fake2\/f1-c/)
})

test('stealth and :free upstreams are public-only', async () => {
  const s = sandbox()
  const upstream = JSON.stringify({ 'fake2/f1-c': 'stealth/alpha', 'fake/f1-b': 'acme/model:free' })
  const r = await s.fanout(base(s, ['--all']), { env: { FAKE_UPSTREAM: upstream } })
  expect(r.stdout).not.toMatch(/fake2\/f1-c/)
  expect(r.stdout).not.toMatch(/fake\/f1-b/)
  const pub = await s.fanout(base(s, ['--all', '--public']), { env: { FAKE_UPSTREAM: upstream } })
  expect(pub.stdout).toMatch(/fake2\/f1-c/)
  expect(pub.stdout).toMatch(/fake\/f1-b/)
})

test('a public-only catalog row stays public-only whatever the upstream', async () => {
  const s = sandbox()
  const r = await s.fanout(base(s, ['--all']), {
    env: { FAKE_UPSTREAM: JSON.stringify({ 'fake3/f1-pub': 'acme/ok' }) }
  })
  expect(r.stdout).not.toMatch(/fake3\/f1-pub/)
})

test('only public-only rows left', async () => {
  const s = sandbox()
  s.catalogPrivate('harness,model,status\nfake,*,retired\nfake2,*,retired\nfake3,*,retired\nfake3,f1-pub,active\n')
  const r = await s.fanout(base(s))
  expect(r.code).toBe(3)
  expect(r.stdout.trim()).toBe('REFUSED no eligible candidate (private chunk; public-only rows skipped: 1)')
})
