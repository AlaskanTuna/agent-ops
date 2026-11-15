import { test, expect } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { sandbox } from './helpers/sandbox'

const BASE = '2026-11-15T01:00:00Z'
const DAY_MS = 24 * 3600 * 1000

function runArgs(sb: ReturnType<typeof sandbox>) {
  return [
    'run',
    '--brief',
    sb.brief('Rename foo in a.txt to bar, nothing else.'),
    '--dir',
    sb.repo,
    '--kind',
    'transcribe'
  ]
}

function age(sb: ReturnType<typeof sandbox>, path: string, days: number, nowMs: number): void {
  void sb
  const t = new Date(nowMs - days * DAY_MS)
  utimesSync(path, t, t)
}

function upkeepAt(sb: ReturnType<typeof sandbox>, iso: string, cwd?: string) {
  sb.at(iso)
  return sb.fanout(['upkeep', '--only', 'housekeeping'], cwd === undefined ? {} : { cwd })
}

function git(sb: ReturnType<typeof sandbox>, args: string[]): string {
  const p = Bun.spawnSync(['git', '-C', sb.repo, ...args], { stdout: 'pipe', stderr: 'ignore' })
  return p.exitCode === 0 ? p.stdout.toString() : ''
}

test('old worktrees go and young ones stay', async () => {
  const sb = sandbox().at(BASE)
  await sb.fanout(runArgs(sb))
  sb.at('2026-11-17T01:00:00Z')
  await sb.fanout(runArgs(sb))
  const roots = [
    ...new Set(
      sb
        .ledger()
        .filter((e) => e.event === 'job_start')
        .map((e) => String(e.root))
    )
  ]
  expect(roots).toHaveLength(2)
  const wt = join(sb.home, 'worktrees')
  const dirs = readdirSync(wt).filter((d) => !d.endsWith('.fanout-repo'))
  expect(dirs).toHaveLength(2)
  const first = dirs.find((d) => d.startsWith(roots[0])) as string
  const second = dirs.find((d) => d.startsWith(roots[1])) as string
  const nowMs = Date.parse('2026-11-23T01:00:00Z')
  age(sb, join(wt, first), 8, nowMs)
  age(sb, join(wt, second), 6, nowMs)
  const r = await upkeepAt(sb, '2026-11-23T01:00:00Z')
  expect(r.code).toBe(0)
  const list = git(sb, ['worktree', 'list'])
  expect(list).not.toContain(first)
  expect(list).toContain(second)
  expect(existsSync(join(wt, first))).toBe(false)
  expect(existsSync(join(wt, second))).toBe(true)
}, 120000)

test('the ref goes with the last worktree', async () => {
  const sb = sandbox().at(BASE)
  await sb.fanout(runArgs(sb))
  sb.at('2026-11-17T01:00:00Z')
  await sb.fanout(runArgs(sb))
  const roots = [
    ...new Set(
      sb
        .ledger()
        .filter((e) => e.event === 'job_start')
        .map((e) => String(e.root))
    )
  ]
  const wt = join(sb.home, 'worktrees')
  const dirs = readdirSync(wt).filter((d) => !d.endsWith('.fanout-repo'))
  const nowMs = Date.parse('2026-11-23T01:00:00Z')
  age(sb, join(wt, dirs.find((d) => d.startsWith(roots[0])) as string), 8, nowMs)
  age(sb, join(wt, dirs.find((d) => d.startsWith(roots[1])) as string), 6, nowMs)
  await upkeepAt(sb, '2026-11-23T01:00:00Z')
  const refs = git(sb, ['for-each-ref', 'refs/fanout/'])
  expect(refs).not.toContain(roots[0])
  expect(refs).toContain(roots[1])
}, 120000)

test('logs and patches follow their ages', async () => {
  const sb = sandbox().at(BASE)
  const nowMs = Date.parse('2026-11-23T01:00:00Z')
  mkdirSync(join(sb.home, 'logs'), { recursive: true })
  mkdirSync(join(sb.home, 'patches'), { recursive: true })
  const files: [string, number][] = [
    [join(sb.home, 'logs', 'a13.log'), 13],
    [join(sb.home, 'logs', 'a15.log'), 15],
    [join(sb.home, 'patches', 'b29.patch'), 29],
    [join(sb.home, 'patches', 'b31.patch'), 31]
  ]
  for (const [p, days] of files) {
    writeFileSync(p, 'x')
    age(sb, p, days, nowMs)
  }
  const r = await upkeepAt(sb, '2026-11-23T01:00:00Z')
  expect(r.code).toBe(0)
  expect(existsSync(join(sb.home, 'logs', 'a13.log'))).toBe(true)
  expect(existsSync(join(sb.home, 'logs', 'a15.log'))).toBe(false)
  expect(existsSync(join(sb.home, 'patches', 'b29.patch'))).toBe(true)
  expect(existsSync(join(sb.home, 'patches', 'b31.patch'))).toBe(false)
}, 60000)

test('smoke folders last one day', async () => {
  const sb = sandbox().at(BASE)
  const nowMs = Date.parse('2026-11-23T01:00:00Z')
  mkdirSync(join(sb.home, 'smoke', 'a'), { recursive: true })
  mkdirSync(join(sb.home, 'smoke', 'b'), { recursive: true })
  age(sb, join(sb.home, 'smoke', 'a'), 2, nowMs)
  age(sb, join(sb.home, 'smoke', 'b'), 2 / 24, nowMs)
  const r = await upkeepAt(sb, '2026-11-23T01:00:00Z')
  expect(r.code).toBe(0)
  expect(existsSync(join(sb.home, 'smoke', 'a'))).toBe(false)
  expect(existsSync(join(sb.home, 'smoke', 'b'))).toBe(true)
}, 60000)

test('a worktree whose repo is gone is removed without error', async () => {
  const sb = sandbox().at(BASE)
  await sb.fanout(runArgs(sb))
  const wt = join(sb.home, 'worktrees')
  const dirs = readdirSync(wt).filter((d) => !d.endsWith('.fanout-repo'))
  expect(dirs).toHaveLength(1)
  rmSync(sb.repo, { recursive: true, force: true })
  const nowMs = Date.parse('2026-11-23T01:00:00Z')
  age(sb, join(wt, dirs[0]), 8, nowMs)
  const r = await upkeepAt(sb, '2026-11-23T01:00:00Z', sb.home)
  expect(r.code).toBe(0)
  expect(existsSync(join(wt, dirs[0]))).toBe(false)
  const step = sb.ledger().find((e) => e.event === 'upkeep' && e.step === 'housekeeping')
  expect(step).toMatchObject({ status: 'ok' })
}, 120000)

test('a stale lease is reaped once', async () => {
  const sb = sandbox().at(BASE)
  mkdirSync(join(sb.home, 'run'), { recursive: true })
  writeFileSync(
    join(sb.home, 'run', '01JZZZZZZZZZZZZZZZZZZZZZZZZ.lease'),
    JSON.stringify({
      root: '01JZZZZZZZZZZZZZZZZZZZZZZZZ',
      job: '01JZZZZZZZZZZZZZZZZZZZZZZZZ',
      pid: 999999999,
      startTicks: 1,
      pgid: 0,
      workerTicks: 0,
      harness: '',
      model: '',
      started: BASE,
      heartbeat: BASE
    })
  )
  const first = await upkeepAt(sb, BASE)
  expect(first.code).toBe(0)
  expect(existsSync(join(sb.home, 'run', '01JZZZZZZZZZZZZZZZZZZZZZZZZ.lease'))).toBe(false)
  const second = await upkeepAt(sb, BASE)
  expect(second.code).toBe(0)
  const events = sb.ledger().filter((e) => e.event === 'upkeep' && e.step === 'housekeeping')
  expect(events).toHaveLength(2)
  expect(String(events[1].detail)).toContain('0 leases')
}, 60000)
