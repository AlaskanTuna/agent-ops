import { test, expect } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
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

test('a context-length error stops the chain', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['job_error_ctx'] })
  const r = await sb.fanout(runArgs(sb))
  expect(r.code).toBe(1)
  expect(r.stdout.split('\n')[0]).toMatch(/outcome=job_error attempt=1/)
  expect(r.stdout).toMatch(/^FAILED job_error: context_length_exceeded/m)
  expect(sb.ledger().filter((e) => e.event === 'job_start')).toHaveLength(1)
  expect(sb.ledger().find((e) => e.event === 'limit_hit')).toBeUndefined()
  expect(sb.ledger().find((e) => e.event === 'job_end')).toMatchObject({ outcome: 'job_error', pattern: 'gen-job' })
}, 30000)

test('413, 422 and a turn cap are job errors', async () => {
  for (const stderr of ['HTTP 413 Payload Too Large', 'HTTP 422 Unprocessable Entity', 'error_max_turns']) {
    const sb = sandbox().at('2026-11-15T01:00:00Z')
    sb.catalogPrivate(NO_PAID)
    sb.script({ 'fake/f1-a': ['custom_error'] })
    const r = await sb.fanout(runArgs(sb), { env: { FAKE_STDERR: stderr } })
    expect(r.code).toBe(1)
    expect(sb.ledger().find((e) => e.event === 'job_end')).toMatchObject({ outcome: 'job_error' })
    expect(sb.ledger().filter((e) => e.event === 'job_start')).toHaveLength(1)
  }
}, 60000)

test('job_error does not cool the model', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['job_error_ctx'] })
  await sb.fanout(runArgs(sb))
  sb.at('2026-11-15T01:01:00Z')
  sb.script({ 'fake/f1-a': ['ok'] })
  const r = await sb.fanout(runArgs(sb))
  expect(r.code).toBe(0)
  const starts = sb.ledger().filter((e) => e.event === 'job_start')
  expect(starts[starts.length - 1]).toMatchObject({ harness: 'fake', model: 'f1-a' })
  expect(sb.ledger().find((e) => e.event === 'limit_hit')).toBeUndefined()
}, 60000)

test('a clean exit that changed nothing is no_effect', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['ok_no_write'] })
  const r = await sb.fanout(runArgs(sb))
  expect(r.code).toBe(1)
  expect(r.stdout.split('\n')[0]).toMatch(/outcome=no_effect attempt=1/)
  expect(r.stdout).toMatch(/^FAILED no_effect: the worker exited 0 but changed no file\. Read LOG=/m)
  expect(sb.ledger().filter((e) => e.event === 'job_start')).toHaveLength(1)
  expect(sb.ledger().find((e) => e.event === 'limit_hit')).toBeUndefined()
}, 30000)

test('no_effect in a non-git directory', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  const plain = join(sb.home, 'plain')
  mkdirSync(plain, { recursive: true })
  sb.script({ 'fake/f1-a': ['ok_no_write'] })
  const r = await sb.fanout(['run', '--brief', sb.brief(), '--dir', plain, '--kind', 'transcribe'])
  expect(r.code).toBe(1)
  expect(r.stdout.split('\n')[0]).toMatch(/outcome=no_effect attempt=1/)
}, 30000)

test('a stdout-only kind stays ok', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['ok_no_write'] })
  const r = await sb.fanout(runArgs(sb, ['--kind', 'inventory']))
  expect(r.code).toBe(0)
  expect(r.stdout.split('\n')[0]).toMatch(/outcome=ok/)
}, 30000)

test('a capped manifest stays ok', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  const plain = join(sb.home, 'big')
  mkdirSync(plain, { recursive: true })
  for (let i = 0; i < 5001; i++) writeFileSync(join(plain, `f${i}.txt`), 'x\n')
  sb.script({ 'fake/f1-a': ['ok_no_write'] })
  const r = await sb.fanout(['run', '--brief', sb.brief(), '--dir', plain, '--kind', 'transcribe'])
  expect(r.code).toBe(0)
  expect(r.stdout.split('\n')[0]).toMatch(/outcome=ok/)
}, 60000)

test('a worker that writes a file is ok', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['ok'] })
  const r = await sb.fanout(runArgs(sb))
  expect(r.code).toBe(0)
  expect(r.stdout.split('\n')[0]).toMatch(/outcome=ok/)
}, 30000)
