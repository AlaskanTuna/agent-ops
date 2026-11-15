import { test, expect } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { sandbox } from './helpers/sandbox'

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

test('--effort outside the list exits 2', async () => {
  const sb = sandbox()
  const r = await sb.fanout(runArgs(sb, ['--effort', 'high']))
  expect(r.code).toBe(2)
  expect(r.stderr).toContain('effort high is not one of medium|low for fake/f1-a')
}, 30000)

test('--effort inside the list is used', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['ok'] })
  const r = await sb.fanout(runArgs(sb, ['--effort', 'low']))
  expect(r.code).toBe(0)
  expect(sb.ledger().find((e) => e.event === 'job_start')).toMatchObject({ effort: 'low' })
}, 30000)

test('a row without efforts takes none', async () => {
  const sb = sandbox()
  const r = await sb.fanout(runArgs(sb, ['--dry-run', '--tier', '3', '--harness', 'fake3']))
  expect(r.code).toBe(0)
  expect(r.stdout).toMatch(/^DRYRUN fake3\/f3-a effort= /m)
  const bad = await sb.fanout(runArgs(sb, ['--dry-run', '--tier', '3', '--harness', 'fake3', '--effort', 'high']))
  expect(bad.code).toBe(2)
  expect(bad.stderr).toContain('fake3/f3-a takes no effort option')
}, 30000)

test('--no-paid hides paid and per-call rows', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  const big = sb.brief('Rename foo in a.txt to bar, nothing else.', 7000)
  const p = await sb.fanout(['pick', '--all', '--brief', big, '--dir', sb.repo, '--kind', 'transcribe', '--no-paid'])
  expect(p.code).toBe(0)
  expect(p.stdout).not.toContain('fake2/f1-paid')
  expect(p.stdout).not.toContain('fake3/f1-paid-b')
  expect(p.stdout).not.toContain('fake3/f1-call')
  sb.script({ 'fake/f1-a': ['rate_limited'], 'fake/f1-b': ['rate_limited'], 'fake2/f1-c': ['rate_limited'] })
  const r = await sb.fanout(runArgs(sb, ['--no-paid']))
  expect(r.code).toBe(0)
  expect(r.stdout.split('\n')[0]).toMatch(/model=f2-a/)
}, 60000)

test('--bypass outside git exits 2', async () => {
  const sb = sandbox()
  const plain = join(sb.home, 'plain')
  mkdirSync(plain, { recursive: true })
  const r = await sb.fanout(['run', '--brief', sb.brief(), '--dir', plain, '--kind', 'transcribe', '--bypass'])
  expect(r.code).toBe(2)
  expect(r.stderr).toContain('--bypass needs a git repository')
}, 30000)

test('--dry-run prints the command and starts nothing', async () => {
  const sb = sandbox()
  const secret = randomBytes(18).toString('base64')
  const pidfile = join(sb.home, 'pidfile')
  const r = await sb.fanout(runArgs(sb, ['--dry-run']), { env: { FAKE_SECRET: secret, FAKE_PIDFILE: pidfile } })
  expect(r.code).toBe(0)
  expect(r.stdout).toMatch(/^DRYRUN fake\/f1-a effort=medium cwd=.* argv=\[.*\]$/m)
  expect(r.stdout).toContain('[secret]')
  expect(r.stdout).not.toContain(secret)
  expect(sb.ledger()).toEqual([])
  expect(existsSync(pidfile)).toBe(false)
}, 30000)

test('passthrough flags reach the argv', async () => {
  const sb = sandbox()
  const r = await sb.fanout(
    runArgs(sb, ['--dry-run', '--max-turns', '12', '--allow', 'Bash(git status)', '--allow', 'Edit'])
  )
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('"--max-turns","12","--allow","Bash(git status)","--allow","Edit"')
  const d = await sb.fanout(runArgs(sb, ['--dry-run']))
  expect(d.stdout).toContain('"--max-turns","8"')
}, 30000)
