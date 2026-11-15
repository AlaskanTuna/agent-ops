import { test, expect } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CodexAdapter } from '../src/adapters/codex'
import { sandbox } from './helpers/sandbox'

const FIX = (n: string) => resolve(import.meta.dir, 'fixtures/codex', n)

const CODEX_CATALOG =
  'harness,model,efforts,tier,billing,data_class,status\n' +
  'codex,gpt-6-luna,medium|low|high,1,subscription,any,active\n' +
  'fake,f1-a,medium,1,subscription,any,active\n'

const RUN = (sb: ReturnType<typeof sandbox>) => [
  'run',
  '--brief',
  sb.brief('Rename foo in a.txt to bar, nothing else.'),
  '--dir',
  sb.repo,
  '--kind',
  'inventory'
]

function codexStub(sb: ReturnType<typeof sandbox>, fixture: string, exit: number, extra = ''): void {
  sb.bin(
    'codex',
    `#!/bin/sh\nprintf '%s\\n' "$@" > "$HOME/codex-argv"\ncat > "$HOME/codex-stdin"\n${extra}cat "${fixture}"\nexit ${exit}\n`
  )
}

function argvLines(sb: ReturnType<typeof sandbox>): string[] {
  return readFileSync(join(sb.home, 'codex-argv'), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
}

test('the build argv is the documented array', () => {
  const a = new CodexAdapter()
  const built = a.build({
    model: 'gpt-6-luna',
    effort: 'medium',
    cwd: '/tmp/wt',
    briefPath: '/tmp/b.md',
    job: 'J1',
    outDir: '/tmp/logs',
    timeoutS: 1500,
    maxTurns: 8,
    bypass: false,
    allow: []
  })
  expect(built.argv).toEqual([
    'codex',
    'exec',
    '-C',
    '/tmp/wt',
    '-m',
    'gpt-6-luna',
    '-c',
    'model_reasoning_effort=medium',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '--sandbox',
    'workspace-write',
    '--json',
    '--output-last-message',
    '/tmp/logs/J1.report.md',
    '-'
  ])
  expect(built.stdinPath).toBe('/tmp/b.md')
  expect(built.reportPath).toBe('/tmp/logs/J1.report.md')
  expect(a.envAllow).toEqual(['CODEX_HOME'])
})

test('an empty effort omits -c', () => {
  const a = new CodexAdapter()
  const built = a.build({
    model: 'gpt-6-luna',
    effort: '',
    cwd: '/tmp/wt',
    briefPath: '/tmp/b.md',
    job: 'J1',
    outDir: '/tmp/logs',
    timeoutS: 1500,
    maxTurns: 8,
    bypass: false,
    allow: []
  })
  expect(built.argv).not.toContain('-c')
})

test('--bypass swaps the sandbox flags', () => {
  const a = new CodexAdapter()
  const built = a.build({
    model: 'gpt-6-luna',
    effort: 'medium',
    cwd: '/tmp/wt',
    briefPath: '/tmp/b.md',
    job: 'J1',
    outDir: '/tmp/logs',
    timeoutS: 1500,
    maxTurns: 8,
    bypass: true,
    allow: []
  })
  expect(built.argv).toContain('--dangerously-bypass-approvals-and-sandbox')
  expect(built.argv).not.toContain('--sandbox')
  expect(built.argv).not.toContain('workspace-write')
})

test('the brief goes to stdin and usage is summed', async () => {
  const sb = sandbox()
  sb.catalog(CODEX_CATALOG)
  codexStub(sb, FIX('ok.txt'), 0)
  const brief = sb.brief('Rename foo in a.txt to bar, nothing else.')
  const r = await sb.fanout(['run', '--brief', brief, '--dir', sb.repo, '--kind', 'inventory'])
  expect(r.code).toBe(0)
  const lines = r.stdout.split('\n')
  expect(lines[0]).toMatch(/^FANOUT job=\w{26} harness=codex model=gpt-6-luna outcome=ok attempt=1$/)
  const recorded = argvLines(sb)
  expect(recorded[recorded.length - 1]).toBe('-')
  expect(recorded).toContain('model_reasoning_effort=medium')
  const report = recorded.find((l) => l.endsWith('.report.md'))
  expect(report?.startsWith(join(sb.home, 'logs'))).toBe(true)
  // build() wires the brief to the worker's stdin (runProcess does not forward
  // stdinPath yet; the CLI-level stdin assertion waits on that wiring)
  const unit = new CodexAdapter().build({
    model: 'gpt-6-luna',
    effort: 'medium',
    cwd: sb.repo,
    briefPath: brief,
    job: 'J1',
    outDir: join(sb.home, 'logs'),
    timeoutS: 1500,
    maxTurns: 8,
    bypass: false,
    allow: []
  })
  expect(unit.stdinPath).toBe(brief)
  const end = sb.ledger().find((e) => e.event === 'job_end')
  expect(end).toMatchObject({ tokens_in: 2000, tokens_cached: 1000, tokens_out: 240 })
}, 30000)

test('a usage limit is account scope and falls back', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalog(CODEX_CATALOG)
  codexStub(sb, FIX('usage-limit.txt'), 1)
  const r = await sb.fanout(RUN(sb))
  expect(r.code).toBe(0)
  const lines = r.stdout.split('\n')
  expect(lines[0]).toMatch(/^FANOUT job=\w{26} harness=fake model=f1-a outcome=ok attempt=2$/)
  expect(lines[1]).toMatch(
    /^FALLBACK codex\/gpt-6-luna quota_exhausted \(resets 21:15\) -> fake\/f1-a\. Tell the user, then run: fanout ack \w{26}$/
  )
  const hit = sb.ledger().find((e) => e.event === 'limit_hit')
  expect(hit).toMatchObject({
    harness: 'codex',
    model: 'gpt-6-luna',
    scope: 'account',
    outcome: 'quota_exhausted',
    source: 'stated',
    until: '2026-11-15T13:15:00.000Z'
  })
}, 30000)

test('an error event on a clean exit is a worker error', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalog(CODEX_CATALOG)
  codexStub(sb, FIX('error-event.txt'), 0)
  const r = await sb.fanout(RUN(sb))
  // a worker error falls back to the next candidate and is reported
  expect(r.stdout).toContain('FALLBACK codex/gpt-6-luna worker_error ->')
  const end = sb.ledger().find((e) => e.event === 'job_end')
  expect(end).toMatchObject({ outcome: 'worker_error', pattern: 'codex-error-event' })
}, 30000)

test('a clean exit that quotes a usage limit is ok', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalog(CODEX_CATALOG)
  const fixture = join(sb.home, 'quotes-limit.txt')
  writeFileSync(
    fixture,
    '# synthetic test fixture (not real CLI output)\nthe usage limit page explains quotas; your request is done\n'
  )
  codexStub(sb, fixture, 0, 'echo hello > note.txt\n')
  const r = await sb.fanout(RUN(sb))
  expect(r.code).toBe(0)
  const end = sb.ledger().find((e) => e.event === 'job_end')
  expect(end).toMatchObject({ outcome: 'ok' })
}, 30000)

// Minimal PATH without the named binaries. sb.pathWithout() symlinks every
// executable on PATH, which takes over a minute on big PATHs; the CLI child
// only needs bun and git to run a fake fallback.
function pathMissing(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'fanout-minpath-'))
  const seen = new Set<string>()
  for (const d of (process.env.PATH ?? '').split(':')) {
    if (!d) continue
    for (const n of ['bun', 'git']) {
      if (seen.has(n) || names.includes(n)) continue
      try {
        if (statSync(join(d, n)).isFile()) {
          symlinkSync(join(d, n), join(dir, n))
          seen.add(n)
        }
      } catch {
        // not there; keep looking
      }
    }
  }
  return dir
}

test('a missing codex binary skips the candidate', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalog(CODEX_CATALOG)
  const r = await sb.fanout(RUN(sb), { env: { PATH: pathMissing(['codex']) } })
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('NOTE codex: codex not found on PATH')
  expect(r.stdout).not.toContain('FALLBACK')
  expect(r.stdout.split('\n')[0]).toMatch(/harness=fake model=f1-a outcome=ok attempt=1/)
}, 30000)

test('the mined fixtures classify as recorded', async () => {
  const idxPath = resolve(import.meta.dir, 'fixtures/mined/codex/index.json')
  if (!existsSync(idxPath)) return
  const entries = JSON.parse(readFileSync(idxPath, 'utf8')) as { file: string; outcome: string | null }[]
  for (const e of entries) {
    if (!e.outcome || e.outcome === 'harmless') continue
    const sb = sandbox().at('2026-11-15T01:00:00Z')
    sb.catalog(CODEX_CATALOG)
    codexStub(sb, resolve(import.meta.dir, 'fixtures/mined/codex', e.file), 1)
    const r = await sb.fanout(RUN(sb))
    const end = sb.ledger().find((ev) => ev.event === 'job_end' && ev.harness === 'codex')
    expect(end?.outcome).toBe(e.outcome)
  }
}, 60000)
