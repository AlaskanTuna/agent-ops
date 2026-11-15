import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { sandbox } from './helpers/sandbox'

const ROOT = resolve(import.meta.dir, '../..')
const VERIFY_SH = join(ROOT, 'fanout/install/verify.sh')

function sandboxEnv(extra: Record<string, string> = {}): Record<string, string> {
  const sb = sandbox()
  return { ...sb.env, ...extra }
}

function tmpHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'fanout-verify-'))
  if (home === '' || !resolve(home).startsWith(resolve(tmpdir()))) throw new Error('bad tmp home')
  return home
}

test('the sandbox verification passes', () => {
  const r = Bun.spawnSync(['bash', VERIFY_SH], {
    cwd: ROOT,
    env: sandboxEnv(),
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const out = r.stdout.toString()
  // doctor (Task 31) is not built in this worktree, so version cannot pass
  // yet; every other check must. Relax to ALL PASS once doctor lands.
  expect(r.exitCode).toBe(1)
  for (const name of ['fallback', 'cost', 'dryrun', 'detach', 'report', 'hygiene']) {
    expect(out, name).toMatch(new RegExp(`^PASS ${name}:`, 'm'))
  }
  expect(out).toMatch(/^FAIL version: doctor /m)
  expect(out.trim().split('\n').at(-1)).toMatch(/^FAILED 1$/)
}, 300000)

test('a broken fake worker fails the checks', () => {
  const r = Bun.spawnSync(['bash', VERIFY_SH], {
    cwd: ROOT,
    env: sandboxEnv({ FANOUT_FAKE_WORKER: '/nonexistent' }),
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const out = r.stdout.toString()
  expect(r.exitCode).toBe(1)
  expect(out).toMatch(/^FAIL fallback:/m)
  expect(out).toMatch(/^FAIL cost:/m)
  expect(out.trim().split('\n').at(-1)).toMatch(/^FAILED [1-9]/)
}, 300000)

test('live mode in an empty home reports every gap', () => {
  const home = tmpHome()
  const build = makeBuild(home)
  const inst = Bun.spawnSync(['bash', join(build, 'install.sh')], {
    env: { ...process.env, HOME: home, FANOUT_INSTALL_NO_SYSTEMD: '1' } as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  expect(inst.exitCode, inst.stderr.toString()).toBe(0)
  const r = Bun.spawnSync(['bash', VERIFY_SH, '--live'], {
    env: { ...process.env, HOME: home, PATH: process.env.PATH ?? '' } as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const out = r.stdout.toString()
  expect(r.exitCode).toBe(1)
  expect(out).toMatch(/^PASS bin:/m)
  expect(out).toMatch(/^PASS skill:/m)
  expect(out).toMatch(/^FAIL hooks:/m)
  expect(out).toMatch(/^FAIL catalog:/m)
  expect(out).toMatch(/^FAIL docs:/m)
}, 180000)

function makeBuild(home: string): string {
  const lib = join(home, '.local/lib/agent-ops/fanout')
  const p = Bun.spawnSync(['bash', join(ROOT, 'fanout/install/build.sh'), '--out', lib, '--allow-dirty'], {
    cwd: ROOT,
    env: { ...process.env, HOME: home } as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  if (p.exitCode !== 0) throw new Error(`build failed: ${p.stderr.toString()}`)
  const m = /^BUILD \S+ -> (\S+)$/m.exec(p.stdout.toString())
  if (!m) throw new Error(`no BUILD line: ${p.stdout.toString()}`)
  return m[1]
}

test('live mode never writes', () => {
  const home = tmpHome()
  const build = makeBuild(home)
  const inst = Bun.spawnSync(['bash', join(build, 'install.sh')], {
    env: { ...process.env, HOME: home, FANOUT_INSTALL_NO_SYSTEMD: '1' } as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  expect(inst.exitCode).toBe(0)
  const before = snapshot(home)
  const r = Bun.spawnSync(['bash', VERIFY_SH, '--live'], {
    env: { ...process.env, HOME: home, PATH: process.env.PATH ?? '' } as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  expect(r.exitCode).toBe(1)
  expect(snapshot(home)).toBe(before)
}, 180000)

function snapshot(home: string): string {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      let st
      try {
        st = statSync(p)
      } catch {
        files.push(`${p.slice(home.length)}:link`)
        continue
      }
      if (st.isDirectory()) walk(p)
      else files.push(`${p.slice(home.length)}:${st.isFile() ? `${st.size}:${st.mode & 0o777}` : 'other'}`)
    }
  }
  walk(home)
  return files.sort().join('\n')
}
