import { test, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RiverAdapter } from '../src/adapters/river'

// River publishes prices (USD per 1M tokens) at console.river.ai/api/public/pricing.
test('discovery prices River routes from the public pricing JSON by River id', async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({
        inference: [
          { model: 'deepseek-ai/DeepSeek-V4.1-Flash', input: 0.12, cached_input: 0.0024, output: 0.48 },
          { model: 'moonshotai/Kimi-K3', input: 3.0, cached_input: 0.3, output: 15.0 }
        ],
        training_and_sampling: []
      })
    }
  })
  const dir = mkdtempSync(join(tmpdir(), 'river-price-'))
  mkdirSync(dir, { recursive: true })
  const tpl = readFileSync(join(import.meta.dir, 'fixtures/proxy/config.yaml.tpl'), 'utf8').replaceAll('__PORT__', '9')
  writeFileSync(
    join(dir, 'config.yaml'),
    tpl.replace(
      '        alias: glm-5.3-flash-river\n',
      '        alias: glm-5.3-flash-river\n      - name: moonshotai/Kimi-K3\n        alias: kimi-k3-river\n'
    )
  )
  const prev = { dir: process.env.FANOUT_PROXY_DIR, url: process.env.FANOUT_RIVER_PRICING_URL }
  process.env.FANOUT_PROXY_DIR = dir
  process.env.FANOUT_RIVER_PRICING_URL = `http://127.0.0.1:${server.port}/pricing`
  try {
    const models = await new RiverAdapter().listModels()
    const by = new Map(models.map((m) => [m.model, m]))
    expect(by.get('kimi-k3-river')).toMatchObject({ billing: 'paid', priceIn: 3, priceCached: 0.3, priceOut: 15 })
    expect(by.get('deepseek-v4.1-flash-river')).toMatchObject({ priceIn: 0.12, priceCached: 0.0024, priceOut: 0.48 })
    // A route River does not price stays unpriced (the catalog then skips it).
    expect(by.get('glm-5.3-flash-river')?.priceIn).toBeUndefined()
  } finally {
    server.stop()
    if (prev.dir === undefined) delete process.env.FANOUT_PROXY_DIR
    else process.env.FANOUT_PROXY_DIR = prev.dir
    if (prev.url === undefined) delete process.env.FANOUT_RIVER_PRICING_URL
    else process.env.FANOUT_RIVER_PRICING_URL = prev.url
  }
})
