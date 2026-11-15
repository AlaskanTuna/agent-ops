import { test, expect } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { OpenCodeAdapter } from '../src/adapters/opencode'
import { sandbox } from './helpers/sandbox'

const FIX = (n: string) => resolve(import.meta.dir, 'fixtures/opencode', n)

const OPENCODE_CATALOG =
  'harness,model,efforts,tier,billing,data_class,status\n' +
  'opencode,opencode/space-bunny-free,,1,free,any,active\n' +
  'opencode,opencode/step-5-preview-free,,1,free,any,active\n' +
  'fake,f1-a,medium|low,1,subscription,any,active\n'

const BRIEF = 'Rename foo in a.txt to bar, nothing else.'

function runArgs(sb: ReturnType<typeof sandbox>, extra: string[] = []): string[] {
  return [
    'run',
    '--brief',
    sb.brief(BRIEF),
    '--dir',
    sb.repo,
    '--kind',
    'transcribe',
    '--harness',
    'opencode',
    '--model',
    'opencode/opencode/space-bunny-free',
    ...extra
  ]
}

// The worker environment is a strict allowlist, so the stub takes no control
// variables: the replayed fixture and exit code are embedded in its body and it
// records to fixed paths under $HOME, which the allowlist always passes.
function opencodeStub(sb: ReturnType<typeof sandbox>, fixture: string, exit: number, extra = ''): void {
  sb.bin(
    'opencode',
    `#!/bin/sh\nprintf '%s\\n' "$@" > "$HOME/opencode-argv"\nenv > "$HOME/opencode-env"\ncat > "$HOME/opencode-stdin"\n${extra}cat "${fixture}"\nexit ${exit}\n`
  )
}

function argvLines(sb: ReturnType<typeof sandbox>): string[] {
  return readFileSync(join(sb.home, 'opencode-argv'), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
}

function readEnv(sb: ReturnType<typeof sandbox>): Map<string, string> {
  const m = new Map<string, string>()
  for (const line of readFileSync(join(sb.home, 'opencode-env'), 'utf8').split('\n')) {
    if (!line) continue
    const i = line.indexOf('=')
    if (i > 0) m.set(line.slice(0, i), line.slice(i + 1))
  }
  return m
}

test('the build array carries the brief, closes stdin and pins the free session model', () => {
  const sb = sandbox()
  const brief = sb.brief(BRIEF)
  const text = readFileSync(brief, 'utf8')
  const a = new OpenCodeAdapter()
  const built = a.build({
    model: 'opencode/space-bunny-free',
    effort: '',
    cwd: '/tmp/wt',
    briefPath: brief,
    job: 'J1',
    outDir: '/tmp/logs',
    timeoutS: 1500,
    maxTurns: 8,
    bypass: false,
    allow: []
  })
  expect(built.argv).toEqual(['opencode', 'run', '--model', 'opencode/space-bunny-free', '--dir', '/tmp/wt', text])
  expect(built.argv).not.toContain('--variant')
  expect(built.stdinText).toBe('')
  expect(built.env.OPENCODE_CONFIG_CONTENT).toBe('{"small_model":"opencode/space-bunny-free"}')
  expect(a.envAllow).toEqual(['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR'])
  const withEffort = a.build({
    model: 'opencode/space-bunny-free',
    effort: 'high',
    cwd: '/tmp/wt',
    briefPath: brief,
    job: 'J1',
    outDir: '/tmp/logs',
    timeoutS: 1500,
    maxTurns: 8,
    bypass: false,
    allow: []
  })
  expect(withEffort.argv).toContain('--variant')
  expect(withEffort.argv[withEffort.argv.indexOf('--variant') + 1]).toBe('high')
})

test('the dry-run argv and environment', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalog(OPENCODE_CATALOG)
  const brief = sb.brief(BRIEF)
  const r = await sb.fanout([
    'run',
    '--brief',
    brief,
    '--dir',
    sb.repo,
    '--kind',
    'transcribe',
    '--dry-run',
    '--harness',
    'opencode',
    '--model',
    'opencode/opencode/space-bunny-free'
  ])
  expect(r.code).toBe(0)
  const line = r.stdout.split('\n').find((l) => l.startsWith('DRYRUN '))
  expect(line).toBeDefined()
  const m = /^DRYRUN (\S+) effort=(.*) cwd=(.*) argv=(.*)$/.exec(line ?? '')
  if (!m) throw new Error(`no DRYRUN line in: ${r.stdout}`)
  expect(m[1]).toBe('opencode/opencode/space-bunny-free')
  const argv = JSON.parse(m[4]) as string[]
  expect(argv.slice(0, 5)).toEqual(['opencode', 'run', '--model', 'opencode/space-bunny-free', '--dir'])
  expect(argv).not.toContain('--variant')
  expect(argv[argv.length - 1]).toBe(BRIEF)
  expect(argv[5]).toBe(m[3])
})

test('stdin is closed', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalog(OPENCODE_CATALOG)
  opencodeStub(sb, FIX('rejected.txt'), 0)
  const r2 = await sb.fanout(
    [
      'run',
      '--brief',
      sb.brief(BRIEF),
      '--dir',
      sb.repo,
      '--kind',
      'inventory',
      '--harness',
      'opencode',
      '--model',
      'opencode/opencode/space-bunny-free',
      '--timeout',
      '5'
    ],
    {}
  )
  expect(r2.code).toBe(0)
  expect(r2.stdout.split('\n')[0]).toMatch(/harness=fake model=f1-a outcome=ok/)
  expect(readFileSync(join(sb.home, 'opencode-stdin'), 'utf8')).toBe('')
}, 30000)

test('funds, deprecated and subscription texts map to outcomes', async () => {
  const cases: [string, string][] = [
    ['funds.txt', 'credits_exhausted'],
    ['deprecated.txt', 'model_unavailable'],
    ['go-required.txt', 'auth_error']
  ]
  for (const [fix, outcome] of cases) {
    const sb = sandbox().at('2026-11-15T01:00:00Z')
    sb.catalog(OPENCODE_CATALOG)
    opencodeStub(sb, FIX(fix), 1, 'echo changed > changed.txt\n')
    const r = await sb.fanout(runArgs(sb))
    expect(r.code).toBe(0)
    const end = sb.ledger().find((e) => e.event === 'job_end' && e.harness === 'opencode')
    expect(end).toMatchObject({ outcome })
    expect(r.stdout).toContain(`FALLBACK opencode/opencode/space-bunny-free ${outcome} -> fake/f1-a.`)
  }
}, 60000)

test('a silent rejection on a clean exit is a worker error', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalog(OPENCODE_CATALOG)
  opencodeStub(sb, FIX('rejected.txt'), 0, 'echo changed > changed.txt\n')
  const r = await sb.fanout(runArgs(sb))
  expect(r.code).toBe(0)
  const end = sb.ledger().find((e) => e.event === 'job_end' && e.harness === 'opencode')
  expect(end).toMatchObject({ outcome: 'worker_error', exit: 0 })
  expect(r.stdout).toContain('FALLBACK opencode/opencode/space-bunny-free worker_error -> fake/f1-a.')
}, 30000)

test('a 130 KB brief skips the candidate', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalog(OPENCODE_CATALOG)
  opencodeStub(sb, FIX('rejected.txt'), 0)
  const brief = sb.brief(undefined, 130000)
  const r = await sb.fanout([
    'run',
    '--brief',
    brief,
    '--dir',
    sb.repo,
    '--kind',
    'transcribe',
    '--harness',
    'opencode',
    '--model',
    'opencode/opencode/space-bunny-free'
  ])
  expect(r.stdout).toContain('NOTE opencode: brief too large for opencode argv')
  expect(r.stdout.split('\n')[0]).toMatch(/harness=fake model=f1-a outcome=ok/)
  expect(r.stdout).toContain('not started (brief too large for opencode argv) -> fake/f1-a')
}, 30000)

test('the listing is classified by prefix', async () => {
  // Bun resolves binaries with the PATH it started with, so an in-process
  // PATH change never reaches the stub: run the listing in a child that is
  // born with the stub directory first on PATH.
  const sb = sandbox()
  sb.bin('opencode', "#!/bin/sh\nprintf '%s\\n' opencode/space-bunny-free opencode-go/x acme/y\nexit 0\n")
  const adapterPath = resolve(import.meta.dir, '../src/adapters/opencode.ts')
  const proc = Bun.spawn(
    [
      'bun',
      '-e',
      `import { OpenCodeAdapter } from '${adapterPath}'; console.log(JSON.stringify(await new OpenCodeAdapter().listModels()))`
    ],
    {
      env: { ...process.env, PATH: `${join(sb.home, 'bin')}:${process.env.PATH ?? ''}` },
      stdout: 'pipe',
      stderr: 'pipe'
    }
  )
  await proc.exited
  const out = await new Response(proc.stdout).text()
  expect(JSON.parse(out)).toEqual([
    { model: 'opencode/space-bunny-free', billing: 'free' },
    { model: 'opencode-go/x', billing: 'subscription' }
  ])
}, 30000)

test('an unpriced paid discovery row is never listed', async () => {
  const sb = sandbox().at('2026-11-15T01:00:00Z')
  sb.catalog(OPENCODE_CATALOG)
  sb.seedLearned('catalog.auto.json', [
    {
      rows: [
        { harness: 'opencode', model: 'opencode/space-bunny-free', tier: 1, billing: 'free', status: 'active' },
        { harness: 'opencode', model: 'opencode-go/x', tier: 1, billing: 'subscription', status: 'active' },
        { harness: 'opencode', model: 'acme/y', tier: 1, billing: 'paid', status: 'active' }
      ]
    }
  ])
  const r = await sb.fanout(['pick', '--all', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'transcribe'])
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('opencode/opencode/space-bunny-free')
  expect(r.stdout).toContain('opencode/opencode-go/x')
  expect(r.stdout).not.toContain('acme/y')
}, 30000)

test('the mined fixtures classify as recorded', async () => {
  const idxPath = resolve(import.meta.dir, 'fixtures/mined/opencode/index.json')
  if (!existsSync(idxPath)) return
  const entries = JSON.parse(readFileSync(idxPath, 'utf8')) as { file: string; outcome: string | null }[]
  for (const e of entries) {
    if (!e.outcome || e.outcome === 'harmless') continue
    const sb = sandbox().at('2026-11-15T01:00:00Z')
    sb.catalog(OPENCODE_CATALOG)
    opencodeStub(sb, resolve(import.meta.dir, 'fixtures/mined/opencode', e.file), 1, 'echo changed > changed.txt\n')
    const r = await sb.fanout(runArgs(sb))
    void r
    const end = sb.ledger().find((ev) => ev.event === 'job_end' && ev.harness === 'opencode')
    expect(end?.outcome).toBe(e.outcome)
  }
}, 60000)
