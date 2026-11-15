import { test, expect } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
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

const STOP_HOOK = new URL('../bin/fanout-stop-hook', import.meta.url).pathname
const SESSION_HOOK = new URL('../bin/fanout-session-hook', import.meta.url).pathname

async function pipeHook(
  sb: ReturnType<typeof sandbox>,
  wrapper: string,
  payload: string,
  projectDir: string | undefined,
  extraEnv: Record<string, string | undefined> = {}
): Promise<{ code: number; stdout: string }> {
  const env: Record<string, string | undefined> = { ...sb.env, ...extraEnv }
  if (projectDir === undefined) delete env.CLAUDE_PROJECT_DIR
  else env.CLAUDE_PROJECT_DIR = projectDir
  const proc = Bun.spawn([wrapper], {
    env: env as Record<string, string>,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe'
  })
  proc.stdin.write(payload)
  proc.stdin.end()
  const code = await proc.exited
  const stdout = await new Response(proc.stdout).text()
  return { code, stdout }
}

const stopPayload = (session: string, active: boolean) =>
  JSON.stringify({ session_id: session, stop_hook_active: active })

function finalJob(sb: ReturnType<typeof sandbox>): string {
  const starts = sb.ledger().filter((e) => e.event === 'job_start')
  return String(starts[starts.length - 1].job)
}

test('Stop blocks on an unreported fallback of this session', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['rate_limited'] })
  const r = await sb.fanout(RUN(sb))
  expect(r.code).toBe(0)
  const job = finalJob(sb)
  const h = await pipeHook(sb, STOP_HOOK, stopPayload('S1', false), '/tmp/p')
  expect(h.code).toBe(0)
  const parsed = JSON.parse(h.stdout) as { decision?: string; reason?: string }
  expect(parsed.decision).toBe('block')
  expect(parsed.reason).toContain(job)
  expect(parsed.reason).toContain('fallback fake/f1-a -> fake/f1-b')
  expect(parsed.reason).toContain(`fanout ack ${job}`)
}, 30000)

test('after ack there is no output', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['rate_limited'] })
  await sb.fanout(RUN(sb))
  const job = finalJob(sb)
  const starts = sb.ledger().filter((e) => e.event === 'job_start')
  await sb.fanout(['ack', String(starts[0].job)])
  expect(job).toBeTruthy()
  const h = await pipeHook(sb, STOP_HOOK, stopPayload('S1', false), '/tmp/p')
  expect(h.code).toBe(0)
  expect(h.stdout).toBe('')
}, 30000)

test('stop_hook_active true prints nothing', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['rate_limited'] })
  await sb.fanout(RUN(sb))
  const h = await pipeHook(sb, STOP_HOOK, stopPayload('S1', true), '/tmp/p')
  expect(h.code).toBe(0)
  expect(h.stdout).toBe('')
}, 30000)

test("another session's chain is ignored", async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['rate_limited'] })
  await sb.fanout(RUN(sb), { env: { FANOUT_SESSION: 'S2' } })
  const h = await pipeHook(sb, STOP_HOOK, stopPayload('S1', false), '/tmp/p')
  expect(h.code).toBe(0)
  expect(h.stdout).toBe('')
}, 30000)

test('a chain that is still running is ignored', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['rate_limited'], 'fake/f1-b': ['ok_slow'] })
  sb.env.FAKE_SLEEP_S = '4'
  const p = sb.start(RUN(sb))
  await waitFor(() => sb.ledger().filter((e) => e.event === 'job_start').length === 2, 10000)
  const during = await pipeHook(sb, STOP_HOOK, stopPayload('S1', false), '/tmp/p')
  expect(during.code).toBe(0)
  expect(during.stdout).toBe('')
  const r = await p.done()
  expect(r.code).toBe(0)
  const after = await pipeHook(sb, STOP_HOOK, stopPayload('S1', false), '/tmp/p')
  expect(after.code).toBe(0)
  expect(JSON.parse(after.stdout).decision).toBe('block')
}, 30000)

test('an old chain is ignored', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  const old = '2026-11-11T01:00:00.000Z'
  const oldEnd = '2026-11-11T01:01:00.000Z'
  sb.seed([
    {
      ts: old,
      event: 'job_start',
      job: '01HZZZZZZZZZZZZZZZZZZZZZA',
      root: '01HZZZZZZZZZZZZZZZZZZZZZA',
      harness: 'fake',
      model: 'f1-a',
      effort: 'medium',
      tier: 1,
      kind: 'transcribe',
      data_class: 'private',
      attempt: 1,
      reason: 'initial',
      billing: 'subscription',
      caller: 'test',
      session: 'S1'
    },
    {
      ts: oldEnd,
      event: 'job_end',
      job: '01HZZZZZZZZZZZZZZZZZZZZZA',
      root: '01HZZZZZZZZZZZZZZZZZZZZZA',
      harness: 'fake',
      model: 'f1-a',
      outcome: 'rate_limited',
      caller: 'test',
      session: 'S1'
    },
    {
      ts: oldEnd,
      event: 'limit_hit',
      job: '01HZZZZZZZZZZZZZZZZZZZZZA',
      root: '01HZZZZZZZZZZZZZZZZZZZZZA',
      harness: 'fake',
      model: 'f1-a',
      scope: 'model',
      outcome: 'rate_limited',
      source: 'backoff',
      until: '2026-11-11T02:00:00.000Z',
      caller: 'test',
      session: 'S1'
    },
    {
      ts: oldEnd,
      event: 'job_start',
      job: '01HZZZZZZZZZZZZZZZZZZZZZB',
      root: '01HZZZZZZZZZZZZZZZZZZZZZA',
      harness: 'fake',
      model: 'f1-b',
      effort: 'medium',
      tier: 1,
      kind: 'transcribe',
      data_class: 'private',
      attempt: 2,
      reason: 'fallback',
      from_job: '01HZZZZZZZZZZZZZZZZZZZZZA',
      billing: 'subscription',
      caller: 'test',
      session: 'S1'
    },
    {
      ts: oldEnd,
      event: 'job_end',
      job: '01HZZZZZZZZZZZZZZZZZZZZZB',
      root: '01HZZZZZZZZZZZZZZZZZZZZZA',
      harness: 'fake',
      model: 'f1-b',
      outcome: 'ok',
      caller: 'test',
      session: 'S1'
    }
  ])
  const h = await pipeHook(sb, STOP_HOOK, stopPayload('S1', false), '/tmp/p')
  expect(h.code).toBe(0)
  expect(h.stdout).toBe('')
}, 30000)

test('the empty-context guard', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['rate_limited'] })
  await sb.fanout(RUN(sb))
  const h = await pipeHook(sb, STOP_HOOK, stopPayload('S1', false), '')
  expect(h.code).toBe(0)
  expect(h.stdout).toBe('')
}, 30000)

test('an unset project dir exits 0 silently (set -u safe)', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['rate_limited'] })
  await sb.fanout(RUN(sb))
  for (const wrapper of [STOP_HOOK, SESSION_HOOK]) {
    const h = await pipeHook(sb, wrapper, stopPayload('S1', false), undefined)
    expect(h.code).toBe(0)
    expect(h.stdout).toBe('')
  }
}, 30000)

test('a session started in HOME is still checked', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['rate_limited'] })
  await sb.fanout(RUN(sb))
  const h = await pipeHook(sb, STOP_HOOK, stopPayload('S1', false), sb.home)
  expect(h.code).toBe(0)
  expect(JSON.parse(h.stdout).decision).toBe('block')
}, 30000)

test('a corrupt ledger exits 0 silently', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  mkdirSync(join(sb.home, 'events'), { recursive: true })
  appendFileSync(join(sb.home, 'events', '2026-11.jsonl'), '{not json\n')
  const h = await pipeHook(sb, STOP_HOOK, stopPayload('S1', false), '/tmp/p')
  expect(h.code).toBe(0)
  expect(h.stdout).toBe('')
}, 30000)

test('an unwritable home exits 0 silently', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  const h = await pipeHook(sb, STOP_HOOK, stopPayload('S1', false), '/tmp/p', { FANOUT_HOME: '/proc/fanout-nope' })
  expect(h.code).toBe(0)
  expect(h.stdout).toBe('')
}, 30000)

test('SessionStart: ok prints nothing', async () => {
  const sb = sandbox()
  const h = await pipeHook(sb, SESSION_HOOK, JSON.stringify({ session_id: 'S1', source: 'startup' }), '/tmp/p')
  expect(h.code).toBe(0)
  expect(h.stdout).toBe('')
}, 30000)

test('SessionStart: a cooldown becomes additionalContext', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate(NO_PAID)
  sb.script({ 'fake/f1-a': ['rate_limited_reset'] })
  await sb.fanout(RUN(sb))
  const h = await pipeHook(sb, SESSION_HOOK, JSON.stringify({ session_id: 'S1', source: 'startup' }), '/tmp/p')
  expect(h.code).toBe(0)
  const parsed = JSON.parse(h.stdout) as {
    hookSpecificOutput?: { hookEventName?: string; additionalContext?: string }
  }
  expect(parsed.hookSpecificOutput?.hookEventName).toBe('SessionStart')
  expect(parsed.hookSpecificOutput?.additionalContext).toContain('COOLDOWN fake/f1-a')
}, 30000)

test('the wrappers are executable', async () => {
  expect(existsSync(STOP_HOOK)).toBe(true)
  expect(existsSync(SESSION_HOOK)).toBe(true)
  for (const w of [STOP_HOOK, SESSION_HOOK]) {
    const p = Bun.spawn(['test', '-x', w], { stdout: 'ignore', stderr: 'ignore' })
    expect(await p.exited).toBe(0)
  }
})
