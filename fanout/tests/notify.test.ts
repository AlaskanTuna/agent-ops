import { test, expect } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sandbox, waitFor } from './helpers/sandbox'

const BRIEF_TEXT = 'Rename foo in a.txt to bar, nothing else.'
const RUN = (sb: ReturnType<typeof sandbox>) => [
  'run',
  '--brief',
  sb.brief(BRIEF_TEXT),
  '--dir',
  sb.repo,
  '--kind',
  'transcribe'
]

const NO_PAID = 'harness,model,status\nfake2,f1-paid,retired\nfake3,f1-paid-b,retired\n'
const PAID_ONLY = 'harness,model,status\nfake,*,retired\nfake2,f1-c,retired\nfake3,f1-paid-b,retired\n'

function notifyEnv(sb: ReturnType<typeof sandbox>, stub: string): Record<string, string> {
  const out = join(sb.home, 'stub-out.txt')
  return { FANOUT_NOTIFY_CMD: stub, STUB_OUT: out }
}

function stubOut(sb: ReturnType<typeof sandbox>): string {
  return join(sb.home, 'stub-out.txt')
}

// A PATH with the essentials but neither notify-send (not installed here)
// nor powershell.exe (only on slow /mnt/c mounts that pathWithout would walk).
function minimalPath(sb: ReturnType<typeof sandbox>): string {
  return [join(sb.home, 'bin'), `${process.env.HOME}/.bun/bin`, '/usr/local/bin', '/usr/bin', '/bin'].join(':')
}

function appender(sb: ReturnType<typeof sandbox>): string {
  return sb.bin('notify-stub', `#!/bin/sh\nprintf '%s|%s\\n' "$1" "$2" >> "$STUB_OUT"\n`)
}

test('a fallback is notified once', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['rate_limited_reset'] })
  const stub = appender(sb)
  const r = await sb.fanout(RUN(sb), { env: notifyEnv(sb, stub) })
  expect(r.code).toBe(0)
  expect(readFileSync(stubOut(sb), 'utf8')).toBe(
    'fanout: fallback|fake/f1-a rate_limited (resets 18:00) -> fake/f1-b\n'
  )
}, 30000)

test('a paid job is notified with its cost', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(PAID_ONLY)
  const stub = appender(sb)
  const r = await sb.fanout(RUN(sb), { env: notifyEnv(sb, stub) })
  expect(r.code).toBe(0)
  expect(readFileSync(stubOut(sb), 'utf8')).toBe(
    'fanout: paid job|paid API (fake2/f1-paid): estimated $0.14, actual $0.0014 (computed from tokens)\n'
  )
}, 30000)

test('a fallback onto a paid model sends notifications in order', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.script({ 'fake/f1-a': ['rate_limited'], 'fake/f1-b': ['rate_limited'], 'fake2/f1-c': ['rate_limited'] })
  const stub = appender(sb)
  const r = await sb.fanout(RUN(sb), { env: notifyEnv(sb, stub) })
  expect(r.code).toBe(0)
  expect(readFileSync(stubOut(sb), 'utf8')).toBe(
    [
      'fanout: fallback|fake/f1-a rate_limited -> fake/f1-b',
      'fanout: fallback|fake/f1-b rate_limited -> fake2/f1-c',
      'fanout: fallback|fake2/f1-c rate_limited -> fake3/f1-paid-b',
      'fanout: paid job|paid API (fake3/f1-paid-b): estimated $0.07, actual $0.0007 (computed from tokens)',
      ''
    ].join('\n')
  )
}, 30000)

test('a clean subscription run sends nothing', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  const stub = appender(sb)
  const r = await sb.fanout(RUN(sb), { env: notifyEnv(sb, stub) })
  expect(r.code).toBe(0)
  expect(existsSync(stubOut(sb))).toBe(false)
}, 30000)

test('a failing notifier changes nothing', async () => {
  const mk = () => {
    const sb = sandbox().at('2026-11-15T01:00:00Z')
    sb.catalogPrivate(NO_PAID)
    sb.script({ 'fake/f1-a': ['rate_limited_reset'] })
    return sb
  }
  const good = mk()
  const goodStub = appender(good)
  const rGood = await good.fanout(RUN(good), { env: notifyEnv(good, goodStub) })
  const bad = mk()
  const badStub = bad.bin('bad-notify', '#!/bin/sh\nexit 1\n')
  const rBad = await bad.fanout(RUN(bad), { env: notifyEnv(bad, badStub) })
  expect(rBad.code).toBe(0)
  const norm = (s: string) =>
    s.replaceAll(/fanout-home-[A-Za-z0-9-]+/g, 'HOME').replaceAll(/[0-9A-HJKMNP-TV-Z]{26}/g, 'JOB')
  expect(norm(rBad.stdout)).toBe(norm(rGood.stdout))
  expect(readFileSync(join(bad.home, 'errors.log'), 'utf8')).toContain('notify failed')
}, 30000)

test('a hanging notifier is cut off', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['rate_limited_reset'] })
  const childFile = join(sb.home, 'stub-child.txt')
  const stub = sb.bin('hang-notify', `#!/bin/sh\nsleep 30 & echo $! > "${childFile}"\nwait\n`)
  const start = Date.now()
  const r = await sb.fanout(RUN(sb), { env: notifyEnv(sb, stub) })
  expect(Date.now() - start).toBeLessThan(6000)
  expect(r.code).toBe(0)
  const childPid = Number(readFileSync(childFile, 'utf8').trim())
  expect(Number.isFinite(childPid) && childPid > 0).toBe(true)
  await waitFor(() => {
    try {
      process.kill(childPid, 0)
      return false
    } catch {
      return true
    }
  }, 5000)
}, 30000)

test('no notifier at all is silent', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  const r = await sb.fanout(RUN(sb), { env: { PATH: minimalPath(sb), FANOUT_NOTIFY_CMD: undefined } })
  expect(r.code).toBe(0)
  expect(r.stdout.split('\n')[0]).toMatch(/^FANOUT job=\w{26} /)
  expect(r.stderr).toBe('')
}, 30000)

test('an orphan is notified once, and wait never notifies', async () => {
  if (!existsSync('/proc/1/stat')) return
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(PAID_ONLY)
  sb.script({ 'fake2/f1-paid': ['usage_then_sleep'] })
  sb.env.FAKE_SLEEP_S = '30'
  const pidfile = join(sb.home, 'pid')
  sb.env.FAKE_PIDFILE = pidfile
  const stub = appender(sb)
  const p = sb.start(RUN(sb), { env: notifyEnv(sb, stub) })
  await waitFor(() => {
    try {
      if (readFileSync(pidfile, 'utf8').trim().length === 0) return false
      const logs = join(sb.home, 'logs')
      return readdirSync(logs).some((f) => f.endsWith('.log') && readFileSync(join(logs, f), 'utf8').includes('USAGE'))
    } catch {
      return false
    }
  }, 10000)
  process.kill(p.pid, 'SIGKILL')
  await p.done()
  await sb.fanout(['status', '--brief'], { env: notifyEnv(sb, stub) })
  await sb.fanout(['status', '--brief'], { env: notifyEnv(sb, stub) })
  const roots = sb.ledger().filter((e) => e.event === 'job_start')
  const job = String(roots[roots.length - 1].job)
  await sb.fanout(['wait', job])
  await sb.fanout(['wait', job])
  expect(readFileSync(stubOut(sb), 'utf8')).toBe(
    `fanout: paid job|paid API (fake2/f1-paid): estimated $0.14, actual $0.0014 (computed from the worker log)\n`
  )
}, 60000)

test('the powershell path passes text through the environment', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['rate_limited_reset'] })
  const out = stubOut(sb)
  sb.bin(
    'powershell.exe',
    `#!/bin/sh\nprintf 'title=%s\\nbody=%s\\nwslenv=%s\\nargs=%s\\n' "$FANOUT_TOAST_TITLE" "$FANOUT_TOAST_BODY" "$WSLENV" "$*" >> "${out}"\n`
  )
  const path = minimalPath(sb)
  const r = await sb.fanout(RUN(sb), { env: { PATH: path, FANOUT_NOTIFY_CMD: undefined } })
  expect(r.code).toBe(0)
  await waitFor(() => existsSync(out), 10000)
  const text = readFileSync(out, 'utf8')
  expect(text).toContain('title=fanout: fallback\n')
  expect(text).toContain('body=fake/f1-a rate_limited (resets 18:00) -> fake/f1-b\n')
  expect(text).toMatch(/wslenv=.*FANOUT_TOAST_TITLE.*FANOUT_TOAST_BODY/)
  const argv = String(/args=(.*)/.exec(text)?.[1] ?? '')
  expect(argv).not.toContain('fanout: fallback')
  expect(argv).not.toContain('fake/f1-a rate_limited')
}, 30000)
