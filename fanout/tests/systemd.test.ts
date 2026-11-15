import { test, expect } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')
const BUILD_SH = join(ROOT, 'fanout/install/build.sh')
const SERVICE = join(ROOT, 'fanout/systemd/fanout-upkeep.service')
const TIMER = join(ROOT, 'fanout/systemd/fanout-upkeep.timer')

function tmpHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'fanout-sys-'))
  if (home === '' || !resolve(home).startsWith(resolve(tmpdir()))) throw new Error('bad tmp home')
  return home
}

function makeBuild(home: string): string {
  const lib = join(home, '.local/lib/agent-ops/fanout')
  const p = Bun.spawnSync(['bash', BUILD_SH, '--out', lib, '--allow-dirty'], {
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

function stubSystemctl(home: string, exitCode: number): { log: string } {
  const bin = join(home, 'bin')
  Bun.spawnSync(['mkdir', '-p', bin])
  const log = join(home, 'systemctl.log')
  const body = `#!/usr/bin/env bash\necho "$@" >> ${log}\nexit ${exitCode}\n`
  const p = join(bin, 'systemctl')
  writeFileSync(p, body)
  chmodSync(p, 0o755)
  return { log }
}

function inst(
  build: string,
  home: string,
  opts: { noSystemd?: boolean; path?: string } = {}
): { code: number; stdout: string; stderr: string } {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    PATH: `${join(home, 'bin')}:${process.env.PATH ?? ''}`
  }
  if (opts.noSystemd !== false) env.FANOUT_INSTALL_NO_SYSTEMD = '1'
  else delete env.FANOUT_INSTALL_NO_SYSTEMD
  const p = Bun.spawnSync(['bash', join(build, 'install.sh')], {
    env,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() }
}

test('the unit files verify', () => {
  if (!Bun.which('systemd-analyze')) {
    console.log('SKIP: systemd-analyze absent')
    return
  }
  // %h expands to $HOME, so verify against a temp home holding a dummy
  // executable at the stable current path. The real unit files are checked.
  const home = tmpHome()
  const target = join(home, '.local/lib/agent-ops/fanout/current/fanout')
  Bun.spawnSync(['mkdir', '-p', join(home, '.local/lib/agent-ops/fanout/current')])
  writeFileSync(target, '#!/bin/sh\nexit 0\n')
  chmodSync(target, 0o755)
  const p = Bun.spawnSync(['systemd-analyze', '--user', 'verify', SERVICE, TIMER], {
    env: { ...process.env, HOME: home } as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  expect(p.exitCode, p.stderr.toString()).toBe(0)
}, 60000)

test('the service uses the stable path', () => {
  const service = readFileSync(SERVICE, 'utf8')
  const timer = readFileSync(TIMER, 'utf8')
  expect(service).toContain('ExecStart=%h/.local/lib/agent-ops/fanout/current/fanout upkeep')
  expect(service).toContain('Type=oneshot')
  expect(timer).toContain('OnCalendar=daily')
  expect(timer).toContain('Persistent=true')
  expect(timer).toContain('RandomizedDelaySec=1h')
})

test('the flag skips the whole systemd step', () => {
  const home = tmpHome()
  const build = makeBuild(home)
  const { log } = stubSystemctl(home, 0)
  const r = inst(build, home)
  expect(r.code, r.stderr).toBe(0)
  const userDir = join(home, '.config/systemd/user')
  let entries: string[] = []
  try {
    entries = readdirSync(userDir)
  } catch {
    entries = []
  }
  expect(entries.filter((e) => e.startsWith('fanout'))).toEqual([])
  expect(Bun.spawnSync(['test', '-e', log]).exitCode).not.toBe(0)
})

test('without the flag the installer copies the units, reloads and enables', () => {
  const home = tmpHome()
  const build = makeBuild(home)
  const { log } = stubSystemctl(home, 0)
  const r = inst(build, home, { noSystemd: false })
  expect(r.code, r.stderr).toBe(0)
  expect(readFileSync(join(home, '.config/systemd/user/fanout-upkeep.service'), 'utf8')).toContain('Type=oneshot')
  expect(readFileSync(join(home, '.config/systemd/user/fanout-upkeep.timer'), 'utf8')).toContain('OnCalendar=daily')
  const calls = readFileSync(log, 'utf8').trim().split('\n')
  expect(calls).toEqual(['--user daemon-reload', '--user enable --now fanout-upkeep.timer'])
})

test('a failing systemctl is not fatal', () => {
  const home = tmpHome()
  const build = makeBuild(home)
  stubSystemctl(home, 1)
  const r = inst(build, home, { noSystemd: false })
  expect(r.code).toBe(0)
  expect(r.stdout).toMatch(/^WARN /m)
})
