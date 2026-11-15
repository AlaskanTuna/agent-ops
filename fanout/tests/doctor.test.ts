import { test, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sandbox } from './helpers/sandbox'

const AA_KEY = 'SECRET-AAA-123'
const META_KEY = 'SECRET-MMM-999'

function green(sb: ReturnType<typeof sandbox>): { stubOut: string } {
  const home = sb.home
  // Skill links in the three folders.
  mkdirSync(join(home, 'skill-src'), { recursive: true })
  for (const d of ['.claude/skills', '.agents/skills', '.gemini/config/skills']) {
    mkdirSync(join(home, d), { recursive: true })
    symlinkSync(join(home, 'skill-src'), join(home, d, 'fanout'))
  }
  // Settings with both hook groups.
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'fanout-stop-hook' }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'fanout-session-hook' }] }]
      }
    })
  )
  // Login profile so `bash -lc` finds the CLI.
  writeFileSync(join(home, '.profile'), `export PATH="${join(home, 'bin')}:$PATH"\n`)
  sb.bin('fanout', '#!/bin/sh\nexit 0\n')
  sb.bin('systemctl', '#!/bin/sh\necho enabled\n')
  sb.bin('duckdb', '#!/bin/sh\necho "v2.0"\n')
  const stubOut = join(home, 'notify-out.txt')
  writeFileSync(stubOut, '')
  sb.bin('fanout-notify', `#!/bin/sh\necho "$1|$2" >> "${stubOut}"\n`)
  const secrets = join(home, 'secrets.env')
  writeFileSync(secrets, `AA_API_KEY=${AA_KEY}\nMETA_MODEL_API_KEY=${META_KEY}\n`)
  sb.env.FANOUT_SECRETS = secrets
  sb.env.FANOUT_NOTIFY_CMD = join(home, 'bin', 'fanout-notify')
  return { stubOut }
}

// A small PATH of symlinks to real binaries plus the sandbox bin dir.
// pathWithout walks the whole machine PATH (over a minute on big PATHs),
// while the doctor child only needs bash and env here.
function minPath(sb: ReturnType<typeof sandbox>): string {
  const dir = mkdtempSync(join(tmpdir(), 'fanout-doctor-path-'))
  for (const d of (process.env.PATH ?? '').split(':')) {
    if (!d) continue
    for (const n of ['bun', 'bash', 'env', 'sh']) {
      const link = join(dir, n)
      try {
        if (statSync(link).isFile()) continue
      } catch {
        // not linked yet
      }
      try {
        if (statSync(join(d, n)).isFile()) symlinkSync(join(d, n), link)
      } catch {
        // not there; keep looking
      }
    }
  }
  return [join(sb.home, 'bin'), dir].join(':')
}

test('all green prints PASS lines and exits 0', async () => {
  const sb = sandbox()
  green(sb)
  const r = await sb.fanout(['doctor'])
  expect(r.code).toBe(0)
  for (const line of [
    'PASS data-dir:',
    'PASS adapter-fake:',
    'PASS duckdb:',
    'PASS skill:',
    'PASS hooks:',
    'PASS timer:',
    'PASS notify:',
    'PASS aa-key:'
  ]) {
    expect(r.stdout).toContain(line)
  }
  expect(r.stdout).not.toContain('WARN ')
  expect(r.stdout).not.toContain('FAIL ')
  expect(r.stdout + r.stderr).not.toContain(AA_KEY)
  expect(r.stdout + r.stderr).not.toContain(META_KEY)
}, 30000)

test('an auth failure warns and cools the harness once', async () => {
  const sb = sandbox()
  green(sb)
  const env = { FAKE_PREFLIGHT: 'fake:auth_error' }
  const first = await sb.fanout(['doctor'], { env })
  expect(first.code).toBe(0)
  expect(first.stdout).toContain('WARN adapter-fake:')
  expect(first.stdout).toContain('auth_error')
  const hits = () => sb.ledger().filter((e) => e.event === 'limit_hit' && e.harness === 'fake' && e.scope === 'account')
  expect(hits()).toHaveLength(1)
  expect(hits()[0]).toMatchObject({ source: 'backoff' })
  await sb.fanout(['doctor'], { env })
  expect(hits()).toHaveLength(1)
}, 30000)

test('a missing skill link or hook group warns', async () => {
  const sb = sandbox()
  green(sb)
  unlinkSync(join(sb.home, '.gemini', 'config', 'skills', 'fanout'))
  const settings = JSON.parse(readFileSync(join(sb.home, '.claude', 'settings.json'), 'utf8')) as {
    hooks: Record<string, unknown>
  }
  delete settings.hooks.Stop
  writeFileSync(join(sb.home, '.claude', 'settings.json'), JSON.stringify(settings))
  const r = await sb.fanout(['doctor'])
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('WARN skill:')
  expect(r.stdout).toContain('.gemini/config/skills')
  expect(r.stdout).toContain('WARN hooks:')
}, 30000)

test('an unwritable data directory fails', async () => {
  const sb = sandbox()
  green(sb)
  const r = await sb.fanout(['doctor'], { env: { FANOUT_HOME: '/proc/fanout-nope' } })
  expect(r.code).toBe(1)
  expect(r.stdout).toContain('FAIL data-dir:')
}, 30000)

test('a missing duckdb warns', async () => {
  const sb = sandbox()
  green(sb)
  unlinkSync(join(sb.home, 'bin', 'duckdb'))
  const r = await sb.fanout(['doctor'], { env: { PATH: minPath(sb) } })
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('WARN duckdb:')
}, 30000)

test('a missing AA key warns without printing a value', async () => {
  const sb = sandbox()
  green(sb)
  const secrets = join(sb.home, 'secrets.env')
  writeFileSync(secrets, `META_MODEL_API_KEY=${META_KEY}\n`)
  const r = await sb.fanout(['doctor'])
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('WARN aa-key:')
  expect(r.stdout).toContain('AA_API_KEY is not set in')
  expect(r.stdout).not.toContain(META_KEY)
  expect(r.stdout + r.stderr).not.toContain(AA_KEY)
}, 30000)

test('a missing notifier warns, and --notify-test fails', async () => {
  const sb = sandbox()
  green(sb)
  const path = minPath(sb)
  const r = await sb.fanout(['doctor'], { env: { PATH: path, FANOUT_NOTIFY_CMD: undefined } })
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('WARN notify:')
  const t = await sb.fanout(['doctor', '--notify-test'], { env: { PATH: path, FANOUT_NOTIFY_CMD: undefined } })
  expect(t.code).toBe(1)
  expect(t.stdout).toContain('FAIL notify: no notifier found')
}, 30000)

test('--notify-test sends one notification', async () => {
  const sb = sandbox()
  const { stubOut } = green(sb)
  const r = await sb.fanout(['doctor', '--notify-test'])
  expect(r.code).toBe(0)
  expect(readFileSync(stubOut, 'utf8')).toBe('fanout: test|notifications work\n')
}, 30000)
