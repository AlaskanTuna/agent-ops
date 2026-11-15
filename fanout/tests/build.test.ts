import { test, expect } from 'bun:test'
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')
const BUILD_SH = join(ROOT, 'fanout/install/build.sh')

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fanout-build-'))
  // Never let an empty or cwd-relative dir through: the tests below write
  // homes, repos and builds into it, and a bad path would litter the repo.
  if (dir === '' || !resolve(dir).startsWith(resolve(tmpdir()))) throw new Error('bad tmp dir')
  return dir
}

function runBuild(
  args: string[],
  cwd: string,
  env?: Record<string, string>
): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(['bash', BUILD_SH, ...args], {
    cwd,
    env: { ...process.env, ...env } as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() }
}

/** A clean clone of this repo plus the uncommitted build inputs, so the build can run there. */
function seedClone(): string {
  const dir = tmp()
  const clone = join(dir, 'clone')
  const p = Bun.spawnSync(['git', 'clone', '--local', '-q', ROOT, clone], {
    stdout: 'pipe',
    stderr: 'pipe'
  })
  if (p.exitCode !== 0) throw new Error(`clone failed: ${p.stderr.toString()}`)
  for (const f of ['fanout/install/build.sh', 'fanout/skill/SKILL.md']) {
    const src = join(ROOT, f)
    if (existsSync(src)) {
      const dest = join(clone, f)
      Bun.spawnSync(['mkdir', '-p', join(clone, f.split('/').slice(0, -1).join('/'))])
      writeFileSync(dest, readFileSync(src))
    }
  }
  chmodSync(join(clone, 'fanout/install/build.sh'), 0o755)
  return clone
}

function cleanEnv(out: string, extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {
    HOME: tmp(),
    FANOUT_HOME: tmp(),
    FANOUT_NO_LAZY: '1',
    PATH: process.env.PATH ?? '',
    TZ: 'Asia/Kuala_Lumpur',
    ...extra
  }
  return env
}

test('a build lays out the copy', () => {
  const out = tmp()
  const r = runBuild(['--out', out, '--allow-dirty'], ROOT)
  expect(r.code).toBe(0)
  const m = /^BUILD (\S+) -> (\S+)$/m.exec(r.stdout.trim())
  expect(m, r.stdout + r.stderr).not.toBeNull()
  const dest = m![2]
  // Full plan layout: fanout.js, the three shims, the skill, the systemd
  // units, both install scripts and the stamp. The installer never changes
  // the `current` link; install.sh does that.
  for (const f of [
    'fanout.js',
    'fanout',
    'fanout-stop-hook',
    'fanout-session-hook',
    'skill/SKILL.md',
    'install.sh',
    'verify.sh',
    'systemd/fanout-upkeep.service',
    'systemd/fanout-upkeep.timer',
    'BUILD'
  ])
    expect(existsSync(join(dest, f)), f).toBe(true)
  for (const f of ['fanout', 'fanout-stop-hook', 'fanout-session-hook'])
    expect(statSync(join(dest, f)).mode & 0o111, f).not.toBe(0)
}, 120000)

test('the built copy runs without the checkout', () => {
  const out = tmp()
  const r = runBuild(['--out', out, '--allow-dirty'], ROOT)
  expect(r.code).toBe(0)
  const dest = /^BUILD \S+ -> (\S+)$/m.exec(r.stdout.trim())![1]
  const copy = join(tmp(), 'copy')
  cpSync(dest, copy, { recursive: true })
  const env = cleanEnv(out)
  const repo = mkdtempSync(join(tmpdir(), 'fanout-pickrepo-'))
  Bun.spawnSync(['git', 'init', '-q', repo])
  const brief = join(tmp(), 'brief.txt')
  writeFileSync(brief, 'Rename foo in a.txt to bar, nothing else.')
  const v = Bun.spawnSync([join(copy, 'fanout'), '--version'], { env, stdout: 'pipe', stderr: 'pipe' })
  expect(v.exitCode).toBe(0)
  expect(v.stdout.toString().trim()).toBe('fanout 0.1.0')
  const pk = Bun.spawnSync([join(copy, 'fanout'), 'pick', '--brief', brief, '--dir', repo, '--kind', 'transcribe'], {
    env,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  expect(pk.exitCode).toBe(0)
  expect(pk.stdout.toString().split('\n')[0]).toBe(
    'PICK harness=agy model=gemini-3.8-flash tier=1 billing=subscription effort=low data=private'
  )
}, 120000)

test('the built copy loads every upkeep step and the bundled data', () => {
  const out = tmp()
  const r = runBuild(['--out', out, '--allow-dirty'], ROOT)
  expect(r.code).toBe(0)
  const dest = /^BUILD \S+ -> (\S+)$/m.exec(r.stdout.trim())![1]
  const copy = join(tmp(), 'copy')
  cpSync(dest, copy, { recursive: true })
  const env = { ...cleanEnv(out), AA_API_KEY: '', FANOUT_NO_LAZY: '1' }
  for (const step of ['housekeeping', 'patterns', 'benchmarks']) {
    const u = Bun.spawnSync([join(copy, 'fanout'), 'upkeep', '--only', step], { env, stdout: 'pipe', stderr: 'pipe' })
    const text = u.stdout.toString() + u.stderr.toString()
    expect(text, step).not.toContain('failed to load')
    expect(text, step).not.toContain('Cannot find module')
  }
  const st = Bun.spawnSync([join(copy, 'fanout'), 'status'], { env, stdout: 'pipe', stderr: 'pipe' })
  expect(st.stdout.toString()).not.toContain('failed to load')
  // the benchmark seed is bundled: the AA-less status names the seed as the source
  expect(st.stdout.toString()).toContain('values from the bundled seed')
}, 120000)

test('no checkout path is baked into the bundle', () => {
  const out = tmp()
  const r = runBuild(['--out', out, '--allow-dirty'], ROOT)
  expect(r.code).toBe(0)
  const dest = /^BUILD \S+ -> (\S+)$/m.exec(r.stdout.trim())![1]
  expect(readFileSync(join(dest, 'fanout.js'), 'utf8')).not.toContain(ROOT)
}, 120000)

test('a hook wrapper works from the built copy', async () => {
  const out = tmp()
  const r = runBuild(['--out', out, '--allow-dirty'], ROOT)
  expect(r.code).toBe(0)
  const dest = /^BUILD \S+ -> (\S+)$/m.exec(r.stdout.trim())![1]
  const env = cleanEnv(out, { CLAUDE_PROJECT_DIR: '/tmp/p' })
  const proc = Bun.spawn([join(dest, 'fanout-stop-hook')], {
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe'
  })
  proc.stdin.write('{"session_id":"S1","stop_hook_active":false}')
  proc.stdin.end()
  const code = await proc.exited
  const stdout = await new Response(proc.stdout).text()
  expect(code).toBe(0)
  expect(stdout).toBe('')
}, 120000)

test('a dirty tree is refused', () => {
  const clone = seedClone()
  writeFileSync(join(clone, 'fanout/catalog/discovery-ignore.txt'), '^agy/claude-\n^dirty\n')
  const out = join(tmp(), 'out')
  const p = Bun.spawnSync(['bash', join(clone, 'fanout/install/build.sh'), '--out', out], {
    cwd: clone,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  expect(p.exitCode).toBe(2)
  expect(p.stderr.toString()).toContain('working tree is dirty; commit, or pass --allow-dirty')
  expect(existsSync(out)).toBe(false)
}, 120000)

test('the build stamp matches the commit', () => {
  const clone = seedClone()
  const out = tmp()
  const p = Bun.spawnSync(['bash', join(clone, 'fanout/install/build.sh'), '--out', out], {
    cwd: clone,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  expect(p.exitCode, p.stderr.toString()).toBe(0)
  const dest = /^BUILD \S+ -> (\S+)$/m.exec(p.stdout.toString().trim())![1]
  const build: Record<string, string> = {}
  for (const line of readFileSync(join(dest, 'BUILD'), 'utf8').split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) build[line.slice(0, i)] = line.slice(i + 1)
  }
  const sha = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: clone }).stdout.toString().trim()
  expect(build.sha).toBe(sha)
  expect(build.id.startsWith(`0.1.0-${sha}-`)).toBe(true)
  expect(build.dirty).toBe('false')
}, 120000)

test('two builds get different ids', () => {
  const out = tmp()
  const a = runBuild(['--out', out, '--allow-dirty'], ROOT, { FANOUT_NOW: '2026-11-15T01:00:00Z' })
  const b = runBuild(['--out', out, '--allow-dirty'], ROOT, { FANOUT_NOW: '2026-11-15T01:01:00Z' })
  expect(a.code).toBe(0)
  expect(b.code).toBe(0)
  const da = /^BUILD \S+ -> (\S+)$/m.exec(a.stdout.trim())![1]
  const db = /^BUILD \S+ -> (\S+)$/m.exec(b.stdout.trim())![1]
  expect(da).not.toBe(db)
}, 180000)
