import { test, expect } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { sandbox } from './helpers/sandbox'

type SB = ReturnType<typeof sandbox>

const SMALL =
  'harness,model,efforts,tier,billing,price_in,price_cached,price_out,price_call,min_brief_bytes,data_class,status,family,aliases,aa_slug,climb,upstream,note\n' +
  'agy,gemini-4-hydrogen,medium|xhigh,1,subscription,,,,,0,any,active,gemini-4-hydrogen,,,,,,\n' +
  'fake,f1-a,medium|low,1,subscription,,,,,0,any,active,f1-a,,,,,,\n'

const BRIEF = 'Rename foo in a.txt to bar, nothing else.'

// The worker environment is a strict allowlist, so the stub takes no control
// variables: the replayed fixture and exit code are embedded in its body and it
// records to fixed paths under $HOME, which the allowlist always passes.
function agyStub(sb: SB, fixtureName: string, exit: number, fixtureContent?: string): string {
  const content = fixtureContent ?? readFileSync(resolve(import.meta.dir, `./fixtures/agy/${fixtureName}.txt`), 'utf8')
  return (
    '#!/bin/sh\n' +
    'printf \'%s\\n\' "$0" "$@" > "$HOME/stub-argv.txt"\n' +
    'pwd > "$HOME/stub-pwd.txt"\n' +
    'echo changed > changed.txt\n' +
    "cat <<'AGY_FIXTURE_EOF'\n" +
    content +
    (content.endsWith('\n') ? '' : '\n') +
    'AGY_FIXTURE_EOF\n' +
    `exit ${exit}\n`
  )
}

function jobId(firstLine: string): string {
  const m = /^FANOUT job=(\w+)/.exec(firstLine)
  if (!m) throw new Error(`no job id in: ${firstLine}`)
  return m[1]
}

function runArgs(sb: SB, extra: string[] = []): string[] {
  return ['run', '--brief', sb.brief(BRIEF), '--dir', sb.repo, '--kind', 'transcribe', ...extra]
}

test('the stub sees the worktree as cwd and as --add-dir', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalog(SMALL)
  sb.bin('agy', agyStub(sb, 'ok', 0))
  const r = await sb.fanout(runArgs(sb, ['--harness', 'agy', '--model', 'gemini-4-hydrogen']))
  expect(r.code).toBe(0)
  const worktree = readFileSync(join(sb.home, 'stub-pwd.txt'), 'utf8').trim()
  expect(r.stdout).toContain(`WORKTREE=${worktree}`)
  const argv = readFileSync(join(sb.home, 'stub-argv.txt'), 'utf8').split('\n')
  argv.pop()
  expect(argv[0].endsWith('/agy')).toBe(true)
  expect(argv.slice(1)).toEqual([
    '-p',
    BRIEF,
    '--model',
    'gemini-4-hydrogen',
    '--effort',
    'medium',
    '--dangerously-skip-permissions',
    '--disable-slash-commands',
    '--add-dir',
    worktree,
    '--print-timeout',
    '1500s'
  ])
  expect(argv).not.toContain('--mode')
}, 30000)

test('a print-timeout line on exit 0 is a timeout', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalog(SMALL)
  sb.bin('agy', agyStub(sb, 'timeout', 0))
  const r = await sb.fanout(runArgs(sb))
  const ends = sb.ledger().filter((e) => e.event === 'job_end')
  expect(ends.find((e) => e.harness === 'agy')).toMatchObject({ outcome: 'timeout', pattern: 'agy-timeout' })
  expect(sb.ledger().filter((e) => e.event === 'limit_hit')).toEqual([])
  expect(r.stdout).toContain('FALLBACK agy/gemini-4-hydrogen timeout -> fake/f1-a.')
  expect(r.stdout.split('\n')[0]).toMatch(/outcome=ok attempt=2/)
}, 30000)

test('an invalid model selection cools the model', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalog(SMALL)
  sb.bin('agy', agyStub(sb, 'invalid-model', 1))
  const r = await sb.fanout(runArgs(sb))
  const ends = sb.ledger().filter((e) => e.event === 'job_end')
  expect(ends.find((e) => e.harness === 'agy')).toMatchObject({ outcome: 'model_unavailable' })
  expect(sb.ledger().filter((e) => e.event === 'limit_hit')).toMatchObject([
    { harness: 'agy', scope: 'model', outcome: 'model_unavailable' }
  ])
  expect(r.stdout).toContain('FALLBACK agy/gemini-4-hydrogen model_unavailable -> fake/f1-a.')
}, 30000)

test('a clean exit that mentions quota is ok', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalog(SMALL)
  sb.bin('agy', agyStub(sb, 'quota-mention', 0, 'see the quota section\n'))
  const r = await sb.fanout(runArgs(sb))
  expect(r.code).toBe(0)
  expect(r.stdout.split('\n')[0]).toMatch(/harness=agy model=gemini-4-hydrogen outcome=ok/)
  const ends = sb.ledger().filter((e) => e.event === 'job_end')
  expect(ends.find((e) => e.harness === 'agy')).toMatchObject({ outcome: 'ok' })
}, 30000)

test('a 130 KB brief skips agy', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalog(SMALL)
  sb.bin('agy', agyStub(sb, 'ok', 0))
  const brief = sb.brief(undefined, 130000)
  const r = await sb.fanout(['run', '--brief', brief, '--dir', sb.repo, '--kind', 'transcribe'])
  expect(r.stdout).toContain('NOTE agy: brief too large for agy argv')
  expect(r.stdout.split('\n')[0]).toMatch(/harness=fake model=f1-a outcome=ok/)
  expect(r.stdout).toContain('not started (brief too large for agy argv) -> fake/f1-a')
}, 30000)

test('argons effort ceiling is high', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.bin('agy', agyStub(sb, 'ok', 0))
  const r = await sb.fanout(
    runArgs(sb, ['--dry-run', '--harness', 'agy', '--model', 'gemini-4-argon', '--effort', 'xhigh']),
    { noCatalog: true }
  )
  expect(r.code).toBe(2)
  expect(r.stderr).toContain('effort xhigh is not one of high|medium|low for agy/gemini-4-argon')
}, 30000)

test('agy climbs effort before tier', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalogPrivate('harness,model,tier\nagy,gemini-4-argon,3\n')
  sb.bin('agy', agyStub(sb, 'ok', 0))
  const base = () => ['run', '--brief', sb.brief(BRIEF), '--dir', sb.repo, '--kind', 'edit'] as string[]
  const r1 = await sb.fanout([...base(), '--harness', 'agy', '--model', 'gemini-4-hydrogen'], { noCatalog: true })
  expect(r1.code).toBe(0)
  const j1 = jobId(r1.stdout.split('\n')[0])
  const r2 = await sb.fanout([...base(), '--escalate-from', j1], { noCatalog: true })
  expect(r2.code).toBe(0)
  const j2 = jobId(r2.stdout.split('\n')[0])
  const r3 = await sb.fanout([...base(), '--escalate-from', j2], { noCatalog: true })
  expect(r3.code).toBe(0)
  const starts = sb.ledger().filter((e) => e.event === 'job_start')
  expect(starts.map((e) => [e.model, e.effort, e.tier])).toEqual([
    ['gemini-4-hydrogen', 'medium', 2],
    ['gemini-4-hydrogen', 'xhigh', 2],
    ['gemini-4-argon', 'high', 3]
  ])
}, 60000)

test('the mined fixtures classify as recorded', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalog(SMALL)
  const mined = readFileSync(resolve(import.meta.dir, './fixtures/mined/agy/0ec7adbd5321.txt'), 'utf8')
  sb.bin('agy', agyStub(sb, 'mined-quota', 1, mined))
  const r = await sb.fanout(runArgs(sb))
  expect(r.code).toBe(0)
  const ends = sb.ledger().filter((e) => e.event === 'job_end')
  expect(ends.find((e) => e.harness === 'agy')).toMatchObject({ outcome: 'quota_exhausted' })
  expect(sb.ledger().filter((e) => e.event === 'limit_hit')).toMatchObject([
    {
      harness: 'agy',
      scope: 'model',
      outcome: 'quota_exhausted',
      source: 'stated',
      until: '2026-11-15T12:21:00.000Z'
    }
  ])
}, 30000)

// agy ignores its keyring login when it sees an SSH session, so a fanout run
// in an SSH shell must not pass the SSH_* variables to agy models.
test('agy models runs without the SSH session variables', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalog(SMALL)
  sb.bin(
    'agy',
    '#!/bin/sh\n' +
      'if [ -n "$SSH_CONNECTION$SSH_CLIENT$SSH_TTY" ]; then echo "Error: Please sign in"; exit 1; fi\n' +
      'printf "gemini-4-hydrogen-medium\\tGemini 4 Hydrogen (Medium)\\n"\n'
  )
  const env = { SSH_CONNECTION: '100.0.0.1 1 100.0.0.2 22', SSH_CLIENT: '100.0.0.1 1 22', SSH_TTY: '/dev/pts/9' }
  const r = await sb.fanout(['doctor'], { env })
  expect(r.stdout).toMatch(/PASS adapter-agy/)
})
