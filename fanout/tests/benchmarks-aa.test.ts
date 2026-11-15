import { test, expect } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { sandbox } from './helpers/sandbox'

const NOW = '2026-11-15T01:00:00.000Z'

interface SeenRequest {
  page: string | null
  key: string | null
}

function portOf(server: { port?: number | undefined }): number {
  return server.port ?? 0
}

function fakeKey(): string {
  return `aa${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`
}

function secretsFor(sb: ReturnType<typeof sandbox>, key: string): string {
  const p = join(sb.home, 'secrets.env')
  writeFileSync(p, `AA_API_KEY=${key}\n`)
  return p
}

function serve(pages: Record<string, unknown>, seen: SeenRequest[], key: string, opts?: { hang?: boolean }) {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      seen.push({ page: url.searchParams.get('page'), key: req.headers.get('x-api-key') })
      if (opts?.hang) return new Promise<Response>(() => {})
      const body = pages[url.searchParams.get('page') ?? '']
      if (body === undefined) return new Response('no such page', { status: 404 })
      if (typeof body === 'string') return new Response(body, { headers: { 'content-type': 'application/json' } })
      return Response.json(body)
    }
  })
}

function aaPage(version: number, items: unknown[], page: number, hasMore: boolean): Record<string, unknown> {
  return {
    tier: 'free',
    intelligence_index_version: version,
    pagination: { page, page_size: 1, total_pages: 2, has_more: hasMore },
    data: items
  }
}

function aaItem(slug: string, name: string, intel: number, priceIn: number, priceOut: number): Record<string, unknown> {
  return {
    slug,
    name,
    evaluations: { artificial_analysis_intelligence_index: intel },
    pricing: { price_1m_input_tokens: priceIn, price_1m_output_tokens: priceOut }
  }
}

function upkeepEnv(sb: ReturnType<typeof sandbox>, serverPort: number, key: string): Record<string, string> {
  return {
    FANOUT_SECRETS: secretsFor(sb, key),
    FANOUT_AA_URL: `http://127.0.0.1:${serverPort}/free`
  }
}

function readBenchmarksDoc(sb: ReturnType<typeof sandbox>): Record<string, any> {
  return JSON.parse(readFileSync(join(sb.home, 'learned', 'benchmarks.json'), 'utf8')) as Record<string, any>
}

function seedBenchmarksDoc(sb: ReturnType<typeof sandbox>, doc: unknown): void {
  mkdirSync(join(sb.home, 'learned'), { recursive: true })
  writeFileSync(join(sb.home, 'learned', 'benchmarks.json'), JSON.stringify(doc))
}

function upkeepSteps(sb: ReturnType<typeof sandbox>): Record<string, unknown>[] {
  return sb.ledger().filter((e) => e.event === 'upkeep' && e.step === 'benchmarks')
}

test('a good refresh stores values from two pages', async () => {
  const sb = sandbox().at(NOW)
  sb.catalogPrivate('harness,model,aa_slug\nfake,f1-a,slug-a\n')
  const key = fakeKey()
  const seen: SeenRequest[] = []
  const server = serve(
    {
      '1': aaPage(5, [aaItem('slug-a', 'A', 31.7, 0.4, 1.2)], 1, true),
      '2': aaPage(5, [aaItem('other', 'F1-B', 28.4, 0.3, 1.0)], 2, false)
    },
    seen,
    key
  )
  try {
    const r = await sb.fanout(['upkeep', '--only', 'benchmarks'], { env: upkeepEnv(sb, portOf(server), key) })
    expect(r.code).toBe(0)
    expect(seen.map((s) => s.page)).toEqual(['1', '2'])
    expect(seen.every((s) => s.key === key)).toBe(true)
    expect(upkeepSteps(sb)).toHaveLength(1)
    expect(upkeepSteps(sb)[0]).toMatchObject({ step: 'benchmarks', status: 'ok' })
    const events = sb.ledger().filter((e) => e.event === 'benchmark')
    expect(
      events.some((e) => e.model === 'fake/f1-a' && e.source === 'aa' && e.metric === 'aa_intel' && e.value === 31.7)
    ).toBe(true)
    expect(events.some((e) => e.model === 'fake/f1-b' && e.source === 'aa' && e.metric === 'aa_intel')).toBe(true)
    const doc = readBenchmarksDoc(sb)
    expect(doc.aa_index_version).toBe(5)
    expect(doc.refreshed_at).toBe(NOW)
    expect(doc.values['fake/f1-a']).toMatchObject({ aa_intel: 31.7, aa_price_in: 0.4, aa_price_out: 1.2 })
  } finally {
    server.stop()
  }
}, 30000)

test('matching by normalised name when there is no slug', async () => {
  const sb = sandbox().at(NOW)
  const key = fakeKey()
  const seen: SeenRequest[] = []
  const server = serve({ '1': aaPage(5, [aaItem('other', 'F1-B', 29.1, 0.2, 0.9)], 1, false) }, seen, key)
  try {
    const r = await sb.fanout(['upkeep', '--only', 'benchmarks'], { env: upkeepEnv(sb, portOf(server), key) })
    expect(r.code).toBe(0)
    expect(readBenchmarksDoc(sb).values['fake/f1-b']).toMatchObject({ aa_intel: 29.1 })
  } finally {
    server.stop()
  }
}, 30000)

test('a missing key is skipped and reported', async () => {
  const sb = sandbox().at(NOW)
  const seen: SeenRequest[] = []
  const server = serve({ '1': aaPage(5, [], 1, false) }, seen, 'unused')
  try {
    const r = await sb.fanout(['upkeep', '--only', 'benchmarks'], {
      env: { AA_API_KEY: undefined, FANOUT_AA_URL: `http://127.0.0.1:${portOf(server)}/free` }
    })
    expect(r.code).toBe(0)
    expect(upkeepSteps(sb)[0]).toMatchObject({ step: 'benchmarks', status: 'skipped', detail: 'no AA_API_KEY' })
    expect(seen).toHaveLength(0)
    const s = await sb.fanout(['status', '--brief'])
    expect(s.stdout).toContain('BENCH aa skipped: AA_API_KEY missing (values from the bundled seed)')
    const run = await sb.fanout(['run', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'transcribe'])
    expect(run.code).toBe(0)
  } finally {
    server.stop()
  }
}, 60000)

test('an API error keeps the old values and says so', async () => {
  const sb = sandbox().at(NOW)
  const key = fakeKey()
  const seen: SeenRequest[] = []
  let mode: 'ok429' | 'ok500' | 'okjunk' | 'hang' = 'ok429'
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      seen.push({ page: new URL(req.url).searchParams.get('page'), key: req.headers.get('x-api-key') })
      if (mode === 'ok429') return new Response('limited', { status: 429 })
      if (mode === 'ok500') return new Response('broken', { status: 500 })
      if (mode === 'okjunk') return new Response('not json {', { headers: { 'content-type': 'application/json' } })
      return new Promise<Response>(() => {})
    }
  })
  const seeded = {
    refreshed_at: '2026-11-10T00:00:00.000Z',
    aa_index_version: 4,
    values: { 'fake/f1-a': { aa_intel: 40, as_of: '2026-11-10' } }
  }
  seedBenchmarksDoc(sb, seeded)
  const env = { ...upkeepEnv(sb, portOf(server), key), FANOUT_AA_TIMEOUT_S: '1' }
  try {
    const details: string[] = []
    for (const m of ['ok429', 'ok500', 'okjunk', 'hang'] as const) {
      mode = m
      const r = await sb.fanout(['upkeep', '--only', 'benchmarks'], { env })
      expect(r.code).toBe(0)
      const last = upkeepSteps(sb)[upkeepSteps(sb).length - 1]
      expect(last).toMatchObject({ status: 'failed' })
      details.push(String(last.detail))
      if (details.length === 1) {
        const s = await sb.fanout(['status', '--brief'])
        expect(s.stdout).toContain('BENCH aa failed: HTTP 429 (values from 2026-11-10)')
      }
    }
    expect(details).toEqual(['HTTP 429', 'HTTP 500', 'invalid JSON', 'timeout'])
    expect(readBenchmarksDoc(sb).values['fake/f1-a']).toMatchObject({ aa_intel: 40 })
    expect(readBenchmarksDoc(sb).refreshed_at).toBe('2026-11-10T00:00:00.000Z')
  } finally {
    server.stop()
  }
}, 120000)

test('a stale snapshot is shown in status', async () => {
  const sb = sandbox().at(NOW)
  seedBenchmarksDoc(sb, {
    refreshed_at: '2026-11-11T01:00:00.000Z',
    aa_index_version: 4,
    values: { 'fake/f1-a': { aa_intel: 40, as_of: '2026-11-11' } }
  })
  const stale = await sb.fanout(['status', '--brief'])
  expect(stale.stdout).toContain('BENCH aa stale: last refresh 4 days ago')
  seedBenchmarksDoc(sb, {
    refreshed_at: '2026-11-13T01:00:00.000Z',
    aa_index_version: 4,
    values: { 'fake/f1-a': { aa_intel: 40, as_of: '2026-11-13' } }
  })
  const fresh = await sb.fanout(['status', '--brief'])
  expect(fresh.stdout).not.toContain('BENCH aa stale')
}, 30000)

test('a refresh that is not due is skipped', async () => {
  const sb = sandbox().at(NOW)
  const key = fakeKey()
  const seen: SeenRequest[] = []
  const server = serve({ '1': aaPage(5, [aaItem('slug-a', 'A', 31.7, 0.4, 1.2)], 1, false) }, seen, key)
  sb.catalogPrivate('harness,model,aa_slug\nfake,f1-a,slug-a\n')
  try {
    seedBenchmarksDoc(sb, {
      refreshed_at: '2026-11-14T23:00:00.000Z',
      aa_index_version: 5,
      values: {}
    })
    const skipped = await sb.fanout(['upkeep', '--only', 'benchmarks'], { env: upkeepEnv(sb, portOf(server), key) })
    expect(skipped.code).toBe(0)
    expect(upkeepSteps(sb)[0]).toMatchObject({ status: 'skipped', detail: 'refreshed 2h ago' })
    expect(seen).toHaveLength(0)
    seedBenchmarksDoc(sb, {
      refreshed_at: '2026-11-14T00:00:00.000Z',
      aa_index_version: 5,
      values: {}
    })
    const due = await sb.fanout(['upkeep', '--only', 'benchmarks'], { env: upkeepEnv(sb, portOf(server), key) })
    expect(due.code).toBe(0)
    expect(upkeepSteps(sb)[1]).toMatchObject({ status: 'ok' })
    expect(seen).toHaveLength(1)
  } finally {
    server.stop()
  }
}, 30000)

test('no matching row fails without touching the file', async () => {
  const sb = sandbox().at(NOW)
  const key = fakeKey()
  const seen: SeenRequest[] = []
  const server = serve({ '1': aaPage(5, [aaItem('nope', 'No Such Model', 20, 0.1, 0.2)], 1, false) }, seen, key)
  const seeded = {
    refreshed_at: '2026-11-10T00:00:00.000Z',
    aa_index_version: 4,
    values: { 'fake/f1-a': { aa_intel: 40, as_of: '2026-11-10' } }
  }
  seedBenchmarksDoc(sb, seeded)
  try {
    const r = await sb.fanout(['upkeep', '--only', 'benchmarks'], { env: upkeepEnv(sb, portOf(server), key) })
    expect(r.code).toBe(0)
    expect(upkeepSteps(sb)[0]).toMatchObject({ status: 'failed', detail: 'no rows matched' })
    expect(readFileSync(join(sb.home, 'learned', 'benchmarks.json'), 'utf8')).toBe(JSON.stringify(seeded))
  } finally {
    server.stop()
  }
}, 30000)

test('AA prices fill only missing prices of auto rows', async () => {
  const sb = sandbox().at(NOW)
  sb.catalogPrivate('harness,model,aa_slug\nfake2,f1-paid,slug-paid\n')
  sb.seedLearned('catalog.auto.json', [
    JSON.stringify({
      rows: [{ harness: 'fake2', model: 'p-new', tier: '2', billing: 'paid', status: 'trial', aa_slug: 'slug-new' }]
    })
  ])
  const key = fakeKey()
  const seen: SeenRequest[] = []
  const server = serve(
    {
      '1': aaPage(5, [aaItem('slug-new', 'P New', 33, 0.5, 1.5), aaItem('slug-paid', 'F1 Paid', 30, 9, 9)], 1, false)
    },
    seen,
    key
  )
  try {
    const r = await sb.fanout(['upkeep', '--only', 'benchmarks'], { env: upkeepEnv(sb, portOf(server), key) })
    expect(r.code).toBe(0)
    expect(upkeepSteps(sb)[0]).toMatchObject({ status: 'ok' })
    const all = await sb.fanout(['pick', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'edit', '--all'])
    expect(all.stdout).toMatch(/^CAND \d+ fake2\/p-new tier=2 .* status=trial$/m)
    const paid = await sb.fanout(['pick', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'transcribe'])
    expect(paid.stdout).toMatch(/^PAID fake3\/f1-paid-b ESTIMATE \$0\.07 \(prior; fewer than 5 samples\)$/m)
  } finally {
    server.stop()
  }
}, 30000)

test('the key appears nowhere', async () => {
  const sb = sandbox().at(NOW)
  sb.catalogPrivate('harness,model,aa_slug\nfake,f1-a,slug-a\n')
  const key = fakeKey()
  const seen: SeenRequest[] = []
  const server = serve({ '1': aaPage(5, [aaItem('slug-a', 'A', 31.7, 0.4, 1.2)], 1, false) }, seen, key)
  const secrets = secretsFor(sb, key)
  try {
    const r = await sb.fanout(['upkeep', '--only', 'benchmarks'], { env: upkeepEnv(sb, portOf(server), key) })
    expect(r.code).toBe(0)
    expect(r.stdout).not.toContain(key)
    expect(r.stderr).not.toContain(key)
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'secrets.env') continue
        const p = join(dir, name)
        let st
        try {
          st = statSync(p)
        } catch {
          continue
        }
        if (st.isDirectory()) walk(p)
        else if (st.isFile()) {
          try {
            if (readFileSync(p, 'utf8').includes(key)) hits.push(p)
          } catch {
            // binary files are skipped
          }
        }
      }
    }
    walk(sb.home)
    expect(hits).toEqual([])
    expect(existsSync(secrets)).toBe(true)
  } finally {
    server.stop()
  }
}, 30000)

test('the README credits the source', () => {
  const text = readFileSync(resolve(import.meta.dir, '../../README.md'), 'utf8')
  expect(text).toContain('[Artificial Analysis](https://artificialanalysis.ai/)')
})
