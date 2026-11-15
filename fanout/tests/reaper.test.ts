import { test, expect } from 'bun:test'
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
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

const PAID_ONLY = 'harness,model,status\nfake,*,retired\nfake2,f1-c,retired\nfake3,f1-paid-b,retired\n'

function procAvailable(): boolean {
  return existsSync('/proc/1/stat')
}

function startTicks(pid: number): number {
  const text = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const idx = text.lastIndexOf(')')
  const fields = text
    .slice(idx + 1)
    .trim()
    .split(/\s+/)
  return Number(fields[19]) || 0
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForWorkerLog(sb: ReturnType<typeof sandbox>, pidfile: string): Promise<number> {
  let workerPid = 0
  await waitFor(() => {
    try {
      const text = readFileSync(pidfile, 'utf8').trim()
      if (!text) return false
      workerPid = Number(text.split('\n').pop())
      if (!Number.isFinite(workerPid) || workerPid <= 0) return false
      const logs = join(sb.home, 'logs')
      return readdirSync(logs).some((f) => f.endsWith('.log') && readFileSync(join(logs, f), 'utf8').includes('USAGE'))
    } catch {
      return false
    }
  }, 10000)
  return workerPid
}
test('a killed run is reaped, its worker killed and its cost computed', async () => {
  if (!procAvailable()) return
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(PAID_ONLY)
  sb.script({ 'fake2/f1-paid': ['usage_then_sleep'] })
  sb.env.FAKE_SLEEP_S = '30'
  const pidfile = join(sb.home, 'pid')
  sb.env.FAKE_PIDFILE = pidfile
  const p = sb.start(RUN(sb))
  const workerPid = await waitForWorkerLog(sb, pidfile)
  process.kill(p.pid, 'SIGKILL')
  await p.done()
  expect(alive(workerPid)).toBe(true)
  const s = await sb.fanout(['status', '--brief'])
  expect(alive(workerPid)).toBe(false)
  const orphans = sb.ledger().filter((e) => e.event === 'job_end' && e.outcome === 'worker_error')
  expect(orphans).toHaveLength(1)
  expect(orphans[0]).toMatchObject({
    detail: 'orphaned lease',
    tokens_in: 1000,
    tokens_out: 200,
    cost_usd: 0.0014,
    cost_source: 'computed'
  })
  expect(s.stdout).toContain('UNREPORTED')
  expect(s.stdout).toMatch(
    /UNREPORTED \w{26} paid fake2\/f1-paid: estimated \$0\.14, actual \$0\.0014 \(run: fanout ack \w{26}\)/
  )
  const roots = sb.ledger().filter((e) => e.event === 'job_start')
  expect(s.stdout).toContain(`UNREPORTED ${String(roots[roots.length - 1].job)} paid fake2/f1-paid`)
}, 60000)

test('reaping is idempotent', async () => {
  if (!procAvailable()) return
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(PAID_ONLY)
  sb.script({ 'fake2/f1-paid': ['usage_then_sleep'] })
  sb.env.FAKE_SLEEP_S = '30'
  const pidfile = join(sb.home, 'pid')
  sb.env.FAKE_PIDFILE = pidfile
  const p = sb.start(RUN(sb))
  await waitForWorkerLog(sb, pidfile)
  process.kill(p.pid, 'SIGKILL')
  await p.done()
  await sb.fanout(['status', '--brief'])
  await sb.fanout(['status', '--brief'])
  expect(sb.ledger().filter((e) => e.event === 'job_end' && e.outcome === 'worker_error')).toHaveLength(1)
}, 60000)

test('pick and run reap too', async () => {
  if (!procAvailable()) return
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(PAID_ONLY)
  sb.script({ 'fake2/f1-paid': ['usage_then_sleep'] })
  sb.env.FAKE_SLEEP_S = '30'
  const pidfile = join(sb.home, 'pid')
  sb.env.FAKE_PIDFILE = pidfile
  const p = sb.start(RUN(sb))
  await waitForWorkerLog(sb, pidfile)
  process.kill(p.pid, 'SIGKILL')
  await p.done()
  await sb.fanout(['pick', '--brief', sb.brief(BRIEF_TEXT), '--dir', sb.repo, '--kind', 'transcribe'])
  expect(sb.ledger().filter((e) => e.event === 'job_end' && e.outcome === 'worker_error')).toHaveLength(1)
}, 60000)

test('a live lease with an old heartbeat is not reaped', async () => {
  if (!procAvailable()) return
  const sb = sandbox()
  const sleeper = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' })
  try {
    const pid = sleeper.pid
    const ticks = startTicks(pid)
    expect(ticks).toBeGreaterThan(0)
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(sb.home, 'run'), { recursive: true })
    writeFileSync(
      join(sb.home, 'run', 'X.lease'),
      JSON.stringify({
        root: 'X',
        job: 'X',
        pid,
        startTicks: ticks,
        pgid: 0,
        workerTicks: 0,
        harness: 'fake',
        model: 'f1-a',
        started: new Date(Date.now() - 3600 * 1000).toISOString(),
        heartbeat: new Date(Date.now() - 3600 * 1000).toISOString()
      })
    )
    await sb.fanout(['status', '--brief'])
    expect(existsSync(join(sb.home, 'run', 'X.lease'))).toBe(true)
    expect(sb.ledger().filter((e) => e.event === 'job_end')).toHaveLength(0)
  } finally {
    try {
      sleeper.kill()
    } catch {
      // already gone
    }
  }
}, 30000)

test('a reused pid is never signalled', async () => {
  if (!procAvailable()) return
  const sb = sandbox()
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(sb.home, 'run'), { recursive: true })
  const sleeper = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' })
  try {
    const pid = sleeper.pid
    writeFileSync(
      join(sb.home, 'run', 'Y.lease'),
      JSON.stringify({
        root: 'Y',
        job: 'Y',
        pid,
        startTicks: 1,
        pgid: pid,
        workerTicks: 1,
        harness: 'fake',
        model: 'f1-a',
        started: new Date().toISOString(),
        heartbeat: new Date().toISOString()
      })
    )
    const s = await sb.fanout(['status', '--brief'])
    expect(s.code).toBe(0)
    expect(existsSync(join(sb.home, 'run', 'Y.lease'))).toBe(false)
    expect(alive(pid)).toBe(true)
  } finally {
    try {
      sleeper.kill()
    } catch {
      // already gone
    }
  }
}, 30000)

test('wait rebuilds the block of an orphan', async () => {
  if (!procAvailable()) return
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(PAID_ONLY)
  sb.script({ 'fake2/f1-paid': ['usage_then_sleep'] })
  sb.env.FAKE_SLEEP_S = '30'
  const pidfile = join(sb.home, 'pid')
  sb.env.FAKE_PIDFILE = pidfile
  const p = sb.start(RUN(sb))
  await waitForWorkerLog(sb, pidfile)
  process.kill(p.pid, 'SIGKILL')
  await p.done()
  await sb.fanout(['status', '--brief'])
  const roots = sb.ledger().filter((e) => e.event === 'job_start')
  const job = String(roots[roots.length - 1].job)
  const w = await sb.fanout(['wait', job])
  expect(w.code).toBe(1)
  expect(w.stdout).toMatch(
    new RegExp(`^FANOUT job=${job} harness=fake2 model=f1-paid outcome=worker_error attempt=1`, 'm')
  )
  expect(w.stdout).toMatch(
    /^COST paid API \(fake2\/f1-paid\): estimated \$0\.14, actual \$0\.0014 \(computed from the worker log\)\. Tell the user, then run: fanout ack \w{26}$/m
  )
}, 60000)

test('wait rebuilds a missing block from the ledger', async () => {
  const sb = sandbox()
  sb.script({ 'fake/f1-a': ['ok_slow'] })
  sb.env.FAKE_SLEEP_S = '1'
  const d = await sb.fanout([...RUN(sb), '--detach'])
  const id = d.stdout.trim().split('\n')[0].slice(4)
  const r1 = await sb.fanout(['wait', id])
  expect(r1.code).toBe(0)
  unlinkSync(join(sb.home, 'logs', `${id}.block`))
  const r2 = await sb.fanout(['wait', id])
  expect(r2.code).toBe(0)
  expect(r2.stdout).toBe(r1.stdout)
}, 30000)
