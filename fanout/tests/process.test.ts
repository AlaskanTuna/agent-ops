import { test, expect } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { sandbox, waitFor } from './helpers/sandbox'

const RUN = (sb: ReturnType<typeof sandbox>) => [
  'run',
  '--brief',
  sb.brief('Rename foo in a.txt to bar, nothing else.'),
  '--dir',
  sb.repo,
  '--kind',
  'transcribe'
]

test('the lease describes the chain while the worker runs and is gone afterwards', async () => {
  const sb = sandbox()
  sb.script({ 'fake/f1-a': ['ok_slow'] })
  sb.env.FAKE_SLEEP_S = '2'
  const p = sb.start(RUN(sb))
  let leaseFile = ''
  await waitFor(() => {
    const files = existsSync(join(sb.home, 'run')) ? readdirSync(join(sb.home, 'run')) : []
    const found = files.find((f) => f.endsWith('.lease'))
    if (found) leaseFile = join(sb.home, 'run', found)
    if (!found) return false
    try {
      return JSON.parse(readFileSync(leaseFile, 'utf8')).harness === 'fake'
    } catch {
      return false
    }
  })
  const lease = JSON.parse(readFileSync(leaseFile, 'utf8'))
  const starts = sb.ledger().filter((e) => e.event === 'job_start')
  expect(starts.length).toBe(1)
  expect(lease.root).toBe(starts[0].job)
  expect(lease.pid).toBe(p.pid)
  expect(typeof lease.startTicks).toBe('number')
  expect(typeof lease.pgid).toBe('number')
  expect(typeof lease.workerTicks).toBe('number')
  expect(lease.harness).toBe('fake')
  expect(lease.model).toBe('f1-a')
  const r = await p.done()
  expect(r.code).toBe(0)
  const left = existsSync(join(sb.home, 'run'))
    ? readdirSync(join(sb.home, 'run')).filter((f) => f.endsWith('.lease'))
    : []
  expect(left).toEqual([])
})

test('a timeout kills the whole process group', async () => {
  const sb = sandbox()
  sb.script({ 'fake/f1-a': ['timeout'] })
  const pidfile = join(sb.home, 'pids.txt')
  const r = await sb.fanout([...RUN(sb), '--timeout', '1'], { env: { FAKE_PIDFILE: pidfile } })
  const ends = sb.ledger().filter((e) => e.event === 'job_end')
  expect(ends[0]).toMatchObject({ outcome: 'timeout' })
  const dur = ends[0].duration_s as number
  expect(dur).toBeGreaterThanOrEqual(1)
  expect(dur).toBeLessThan(4)
  const pid = Number(readFileSync(pidfile, 'utf8').trim().split('\n')[0])
  let threw = false
  try {
    process.kill(pid, 0)
  } catch (err) {
    threw = true
    expect((err as NodeJS.ErrnoException).code).toBe('ESRCH')
  }
  expect(threw).toBe(true)
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('FALLBACK fake/f1-a timeout -> fake/f1-b.')
})

test('the worker environment is the allowlist and nothing else', async () => {
  const sb = sandbox()
  sb.script({ 'fake/f1-a': ['print_env'] })
  const outFile = join(sb.home, 'env.txt')
  const r = await sb.fanout(RUN(sb), {
    env: { SECRET_PROBE: '1', ANTHROPIC_API_KEY: 'x', FAKE_OUT: outFile, FAKE_FLAG: '1' }
  })
  expect(r.code).toBe(0)
  const text = readFileSync(outFile, 'utf8')
  expect(text).toMatch(/^FANOUT_DEPTH=1$/m)
  expect(text).toMatch(/^FAKE_FLAG=1$/m)
  expect(text).toMatch(/^PATH=/m)
  expect(text).not.toMatch(/^SECRET_PROBE=/m)
  expect(text).not.toMatch(/^ANTHROPIC_API_KEY=/m)
  expect(text).not.toMatch(/^FANOUT_HOME=/m)
  expect(text).not.toMatch(/^FANOUT_FAKE_SCRIPT=/m)
})

test('a nested run is refused', async () => {
  const sb = sandbox()
  const r = await sb.fanout(RUN(sb), { env: { FANOUT_DEPTH: '1' } })
  expect(r.code).toBe(3)
  expect(r.stdout).toContain('REFUSED nested fanout (FANOUT_DEPTH=1)')
  expect(sb.ledger()).toEqual([])
})

test('a worker that calls fanout run is refused', async () => {
  const sb = sandbox()
  sb.script({ 'fake/f1-a': ['nested_run'] })
  const brief = sb.brief('Rename foo in a.txt to bar, nothing else.')
  const outFile = join(sb.home, 'nested.txt')
  const r = await sb.fanout(RUN(sb), {
    env: {
      FAKE_CLI: resolve(import.meta.dir, '../src/cli.ts'),
      FAKE_BRIEF: brief,
      FAKE_OUT: outFile
    }
  })
  expect(r.code).toBe(0)
  expect(readFileSync(outFile, 'utf8')).toContain('REFUSED nested fanout (FANOUT_DEPTH=1)')
})

test('SIGTERM stops the chain cleanly', async () => {
  const sb = sandbox()
  sb.script({ 'fake/f1-a': ['timeout'] })
  const pidfile = join(sb.home, 'pids.txt')
  const p = sb.start(RUN(sb), { env: { FAKE_PIDFILE: pidfile } })
  await waitFor(() => existsSync(pidfile))
  await waitFor(
    () => existsSync(join(sb.home, 'run')) && readdirSync(join(sb.home, 'run')).some((f) => f.endsWith('.lease'))
  )
  process.kill(p.pid, 'SIGTERM')
  const r = await p.done()
  expect(r.code).toBe(143)
  const pid = Number(readFileSync(pidfile, 'utf8').trim().split('\n')[0])
  let threw = false
  try {
    process.kill(pid, 0)
  } catch {
    threw = true
  }
  expect(threw).toBe(true)
  const events = sb.ledger()
  const last = events[events.length - 1]
  expect(last).toMatchObject({ event: 'job_end', outcome: 'worker_error', detail: 'interrupted by SIGTERM' })
  expect(readdirSync(join(sb.home, 'run')).filter((f) => f.endsWith('.lease'))).toEqual([])
}, 15000)

test('SIGINT stops the chain cleanly', async () => {
  const sb = sandbox()
  sb.script({ 'fake/f1-a': ['timeout'] })
  const pidfile = join(sb.home, 'pids.txt')
  const p = sb.start(RUN(sb), { env: { FAKE_PIDFILE: pidfile } })
  await waitFor(() => existsSync(pidfile))
  await waitFor(
    () => existsSync(join(sb.home, 'run')) && readdirSync(join(sb.home, 'run')).some((f) => f.endsWith('.lease'))
  )
  process.kill(p.pid, 'SIGINT')
  const r = await p.done()
  expect(r.code).toBe(130)
  const events = sb.ledger()
  const last = events[events.length - 1]
  expect(last).toMatchObject({ event: 'job_end', outcome: 'worker_error', detail: 'interrupted by SIGINT' })
}, 15000)
