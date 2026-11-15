import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The real CLIProxyAPI config lists providers under openai-compatibility with
// base-url and api-key-entries. Earlier code only read a made-up `providers`
// list, so every proxied harness read the live config as unreadable.
const REAL_SHAPE = `port: 8317
api-keys:
  - client-key
openai-compatibility:
  - name: openrouter
    base-url: https://openrouter.ai/api/v1
    api-key-entries:
      - api-key: upstream-or
    models:
      - name: z-ai/glm-5.3-flash
        alias: glm-5.3-flash
  - name: modelscope
    base-url: https://api-inference.modelscope.ai/v1
    api-key-entries:
      - api-key: upstream-ms
    models:
      - name: Qwen/Qwen3.8-27B
        alias: ms-qwen3.8-27b
  - name: river
    base-url: https://api.river.ai/v1
    api-key-entries:
      - api-key: upstream-river
    models:
      - name: zai-org/GLM-5.3-Flash
        alias: glm-5.3-flash-river
      - name: deepseek-ai/DeepSeek-V4.1-Flash
        alias: deepseek-v4.1-flash-river
`

function withConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fanout-proxy-'))
  writeFileSync(join(dir, 'config.yaml'), REAL_SHAPE)
  return dir
}

test('the shared proxy reader parses the real openai-compatibility shape', async () => {
  process.env.FANOUT_PROXY_DIR = withConfig()
  const { readProxyConfig, upstreamOf } = await import('../src/adapters/proxy')
  const cfg = readProxyConfig()
  expect(cfg.port).toBe(8317)
  expect(cfg.token).toBe('client-key')
  expect(upstreamOf('river', 'glm-5.3-flash-river')).toBe('zai-org/GLM-5.3-Flash')
  expect(upstreamOf('openrouter', 'glm-5.3-flash')).toBe('z-ai/glm-5.3-flash')
})

test('modelscope uses the proxy client key, not the upstream key', async () => {
  process.env.FANOUT_PROXY_DIR = withConfig()
  const { readModelScopeConfig } = await import('../src/adapters/modelscope')
  const cfg = readModelScopeConfig()
  expect(cfg.token).toBe('client-key')
  expect(cfg.models.map((m) => m.alias)).toEqual(['ms-qwen3.8-27b'])
})
