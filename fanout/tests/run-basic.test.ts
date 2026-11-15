import { test, expect } from 'bun:test'
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { sandbox } from './helpers/sandbox'

const RUN = ['run', '--brief', '', '--dir', '', '--kind', 'transcribe']

function runArgs(sb: ReturnType<typeof sandbox>, brief?: string, kind = 'transcribe') {
  return [
    'run',
    '--brief',
    brief ?? sb.brief('Rename foo to bar in a.txt, nothing else.'),
    '--dir',
    sb.repo,
    '--kind',
    kind
  ]
}

test('ok run: block, ledger and exit code', async () => {
  const sb = sandbox()
  const r = await sb.at('2026-11-15T01:00:00Z').fanout(runArgs(sb))
  expect(r.code).toBe(0)
  expect(r.stdout.split('\n')[0]).toMatch(
    /^FANOUT job=[0-9A-HJKMNP-TV-Z]{26} harness=fake model=f1-a outcome=ok attempt=1$/
  )
  const [start, end] = sb.ledger()
  expect(start).toMatchObject({
    v: 1,
    ts: '2026-11-15T01:00:00.000Z',
    event: 'job_start',
    harness: 'fake',
    model: 'f1-a',
    tier: 1,
    kind: 'transcribe',
    attempt: 1,
    reason: 'initial',
    billing: 'subscription',
    data_class: 'private',
    caller: 'test',
    session: 'S1'
  })
  expect(start.brief_sha).toMatch(/^[0-9a-f]{64}$/)
  expect(end).toMatchObject({
    event: 'job_end',
    outcome: 'ok',
    exit: 0,
    tokens_in: 1000,
    tokens_out: 200,
    tokens_cached: 0,
    cost_source: 'computed'
  })
  expect(end.job).toBe(start.job)
  expect(end.root).toBe(start.job)
})

test('edit kind starts at tier 2', async () => {
  const sb = sandbox()
  const r = await sb.fanout(runArgs(sb, undefined, 'edit'))
  expect(r.stdout.split('\n')[0]).toMatch(/ model=f2-a /)
  const [start] = sb.ledger()
  expect(start).toMatchObject({ tier: 2 })
})

test('caller detection', async () => {
  const cases: [Record<string, string>, string, string | undefined][] = [
    [{ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc' }, 'claude-code', 'abc'],
    [{ GEMINI_CLI: '1' }, 'gemini', undefined],
    [{ OPENCODE: '1' }, 'opencode', undefined],
    [{ CODEX_CI: '1' }, 'codex', undefined],
    [{ ANTIGRAVITY_AGENT: '1' }, 'antigravity', undefined],
    [{ COPILOT_CLI: '1' }, 'copilot', undefined],
    [{}, 'unknown', undefined]
  ]
  for (const [extra, caller, session] of cases) {
    const sb = sandbox()
    const scrubbed: Record<string, string | undefined> = {
      FANOUT_CALLER: '',
      FANOUT_SESSION: '',
      CLAUDECODE: undefined,
      CLAUDE_CODE_SESSION_ID: undefined,
      CODEX_THREAD_ID: undefined,
      CODEX_SANDBOX: undefined,
      CODEX_CI: undefined,
      GEMINI_CLI: undefined,
      OPENCODE: undefined
    }
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('ANTIGRAVITY_') || k.startsWith('COPILOT_')) scrubbed[k] = undefined
    }
    await sb.fanout(runArgs(sb), { env: { ...scrubbed, ...extra } })
    const [start] = sb.ledger()
    expect(start.caller).toBe(caller)
    expect(start.session).toBe(session)
  }
})

test('the brief text never reaches the ledger', async () => {
  const sb = sandbox()
  const sentence = 'The owls are not what they seem at dusk.'
  await sb.fanout(runArgs(sb, sb.brief(sentence)))
  const found: string[] = []
  const walk = (dir: string) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name)
      if (f.isDirectory()) walk(p)
      else if (/events|errors\.log$/.test(p) || dir.endsWith('events')) {
        try {
          if (readFileSync(p, 'utf8').includes(sentence)) found.push(p)
        } catch {
          // ignore unreadable files
        }
      }
    }
  }
  walk(sb.home)
  expect(found).toEqual([])
})

test('six concurrent runs leave 12 valid, unique-id lines', async () => {
  const sb = sandbox()
  sb.script({ 'fake/f1-a': ['ok_slow', 'ok_slow', 'ok_slow', 'ok_slow', 'ok_slow', 'ok_slow'] })
  const handles = Array.from({ length: 6 }, () => sb.start(runArgs(sb), { env: { FAKE_SLEEP_S: '1' } }))
  const results = await Promise.all(handles.map((h) => h.done()))
  expect(results.map((r) => r.code)).toEqual([0, 0, 0, 0, 0, 0])
  const events = sb.ledger()
  expect(events).toHaveLength(12)
  expect(new Set(events.map((e) => e.id)).size).toBe(12)
  for (const f of readdirSync(join(sb.home, 'events'))) {
    for (const line of readFileSync(join(sb.home, 'events', f), 'utf8').split('\n')) {
      if (!line.trim()) continue
      expect(() => JSON.parse(line)).not.toThrow()
    }
  }
})

test('no eligible candidate exits 3', async () => {
  const sb = sandbox()
  sb.catalogPrivate('harness,model,status\nfake,*,retired\nfake2,*,retired\nfake3,*,retired\n')
  const r = await sb.fanout(runArgs(sb))
  expect(r.code).toBe(3)
  expect(r.stdout.trim()).toBe('REFUSED no eligible candidate')
  expect(readdirSync(sb.home).filter((f) => f === 'events')).toEqual([])
})

test('a missing flag or an unreadable brief exits 2', async () => {
  const sb = sandbox()
  const missing = await sb.fanout(['run', '--dir', sb.repo, '--kind', 'transcribe'])
  expect(missing.code).toBe(2)
  expect(missing.stderr).toMatch(/usage: fanout run --brief/)
  const unreadable = await sb.fanout(['run', '--brief', '/nope', '--dir', sb.repo, '--kind', 'transcribe'])
  expect(unreadable.code).toBe(2)
  expect(unreadable.stderr).toMatch(/cannot read brief \/nope/)
})

test('modes', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  await sb.fanout(runArgs(sb))
  expect(statSync(join(sb.home, 'events', '2026-11.jsonl')).mode & 0o777).toBe(0o600)
  expect(statSync(sb.home).mode & 0o777).toBe(0o700)
  for (const f of readdirSync(join(sb.home, 'logs'))) {
    expect(statSync(join(sb.home, 'logs', f)).mode & 0o777).toBe(0o600)
  }
})

test('repo is a name, not a path', async () => {
  const sb = sandbox()
  await sb.fanout(runArgs(sb))
  const [start] = sb.ledger()
  expect(typeof start.repo).toBe('string')
  expect(start.repo as string).not.toContain('/')
})

void RUN
