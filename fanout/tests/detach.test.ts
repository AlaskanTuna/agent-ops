import { test, expect } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
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

test('detach returns the job id at once and the chain keeps running', async () => {
  const sb = sandbox()
  sb.script({ 'fake/f1-a': ['ok_slow'] })
  sb.env.FAKE_SLEEP_S = '5'
  const start = Date.now()
  const r = await sb.fanout([...RUN(sb), '--detach'])
  expect(Date.now() - start).toBeLessThan(3000)
  expect(r.code).toBe(0)
  const lines = r.stdout.trim().split('\n')
  expect(lines[0]).toMatch(/^JOB [0-9A-HJKMNP-TV-Z]{26}$/)
  const id = lines[0].slice(4)
  expect(lines[1]).toBe(`WAIT run: fanout wait ${id}`)
  const leaseFile = join(sb.home, 'run', `${id}.lease`)
  expect(existsSync(leaseFile)).toBe(true)
  const lease = JSON.parse(readFileSync(leaseFile, 'utf8'))
  let alive = true
  try {
    process.kill(lease.pid, 0)
  } catch {
    alive = false
  }
  expect(alive).toBe(true)
  await waitFor(() => sb.ledger().filter((e) => e.event === 'job_start').length === 1)
  const starts = sb.ledger().filter((e) => e.event === 'job_start')
  expect(starts.length).toBe(1)
  expect(sb.ledger().filter((e) => e.event === 'job_end').length).toBe(0)
}, 15000)

test('wait prints the result block and exits like run', async () => {
  const sb = sandbox()
  sb.script({ 'fake/f1-a': ['ok_slow'] })
  sb.env.FAKE_SLEEP_S = '2'
  const d = await sb.fanout([...RUN(sb), '--detach'])
  const id = d.stdout.trim().split('\n')[0].slice(4)
  const r = await sb.fanout(['wait', id])
  expect(r.code).toBe(0)
  expect(r.stdout.split('\n')[0]).toMatch(/^FANOUT job=/)

  expect(existsSync(join(sb.home, 'run', `${id}.lease`))).toBe(false)
  expect(statSync(join(sb.home, 'logs', `${id}.block`)).mode & 0o777).toBe(0o600)
}, 30000)

test('wait times out with RUNNING and exit 4, and can be called again', async () => {
  const sb = sandbox()
  sb.script({ 'fake/f1-a': ['ok_slow'] })
  sb.env.FAKE_SLEEP_S = '6'
  const d = await sb.fanout([...RUN(sb), '--detach'])
  const id = d.stdout.trim().split('\n')[0].slice(4)
  const r1 = await sb.fanout(['wait', id], { env: { FANOUT_WAIT_MAX_S: '1' } })
  expect(r1.code).toBe(4)
  expect(r1.stdout.trim()).toBe(`RUNNING job=${id} elapsed=1s; run again: fanout wait ${id}`)
  const r2 = await sb.fanout(['wait', id], { env: { FANOUT_WAIT_MAX_S: '30' } })
  expect(r2.code).toBe(0)
  expect(r2.stdout.split('\n')[0]).toMatch(/^FANOUT job=/)
}, 60000)

test('wait on a finished chain prints the same block again', async () => {
  const sb = sandbox()
  sb.script({ 'fake/f1-a': ['ok_slow'] })
  sb.env.FAKE_SLEEP_S = '1'
  const d = await sb.fanout([...RUN(sb), '--detach'])
  const id = d.stdout.trim().split('\n')[0].slice(4)
  const r1 = await sb.fanout(['wait', id])
  const r2 = await sb.fanout(['wait', id])
  expect(r1.code).toBe(0)
  expect(r2.code).toBe(0)
  expect(r2.stdout).toBe(r1.stdout)
}, 30000)

test('wait on an unknown job exits 2', async () => {
  const sb = sandbox()
  const r = await sb.fanout(['wait', '01HZZZZZZZZZZZZZZZZZZZZZZZ'])
  expect(r.code).toBe(2)
  expect(r.stderr).toContain('unknown job 01HZZZZZZZZZZZZZZZZZZZZZZZ')
})

test('a refused chain is refused before detaching', async () => {
  const sb = sandbox()
  sb.catalogPrivate('harness,model,status\nfake,*,retired\nfake2,*,retired\nfake3,*,retired\n')
  const r = await sb.fanout([...RUN(sb), '--detach'])
  expect(r.code).toBe(3)
  expect(r.stdout).toContain('REFUSED no eligible candidate')
  const logs = existsSync(join(sb.home, 'logs')) ? readdirSync(join(sb.home, 'logs')) : []
  expect(logs.filter((f) => f.endsWith('.chain'))).toEqual([])
})

test('run options reach the detached chain', async () => {
  const sb = sandbox()
  sb.script({ 'fake/f2-a': ['ok'] })
  const d = await sb.fanout([...RUN(sb), '--detach', '--kind', 'edit'])
  expect(d.code).toBe(0)
  const id = d.stdout.trim().split('\n')[0].slice(4)
  const r = await sb.fanout(['wait', id])
  expect(r.code).toBe(0)
  const starts = sb.ledger().filter((e) => e.event === 'job_start')
  expect(starts[0]).toMatchObject({ model: 'f2-a', tier: 2 })
}, 30000)

test('wait rebuilds a missing block from the ledger', async () => {
  const sb = sandbox()
  sb.script({ 'fake/f1-a': ['ok'] })
  const d = await sb.fanout([...RUN(sb), '--detach'])
  const id = d.stdout.trim().split('\n')[0].slice(4)
  const r1 = await sb.fanout(['wait', id])
  expect(r1.code).toBe(0)
  expect(r1.stdout.split('\n')[0]).toMatch(/^FANOUT job=[0-9A-HJKMNP-TV-Z]{26} .* outcome=ok attempt=1$/)
  unlinkSync(join(sb.home, 'logs', `${id}.block`))
  const r2 = await sb.fanout(['wait', id])
  expect(r2.code).toBe(0)
  expect(r2.stdout).toBe(r1.stdout)
}, 30000)
