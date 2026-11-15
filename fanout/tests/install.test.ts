import { test, expect } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')
const BUILD_SH = join(ROOT, 'fanout/install/build.sh')

const BASHRC_SEED = `# seeded bashrc
export EDITOR=vim
case $- in
  *i*) ;;
  *) return ;;
esac
`
const PROFILE_SEED = `# seeded profile
export PAGER=less
`

function tmpHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'fanout-inst-'))
  // Never let an empty or cwd-relative dir through: setupHome writes into
  // it, and a bad path would litter the repo.
  if (home === '' || !resolve(home).startsWith(resolve(tmpdir()))) throw new Error('bad tmp home')
  return home
}

function setupHome(): { home: string; bashrc: string; profile: string } {
  const home = tmpHome()
  writeFileSync(join(home, '.bashrc'), BASHRC_SEED)
  writeFileSync(join(home, '.profile'), PROFILE_SEED)
  return { home, bashrc: BASHRC_SEED, profile: PROFILE_SEED }
}

function makeBuild(home: string, now?: string): string {
  const lib = join(home, '.local/lib/agent-ops/fanout')
  const env: Record<string, string> = { ...process.env, HOME: home } as Record<string, string>
  if (now) env.FANOUT_NOW = now
  const p = Bun.spawnSync(['bash', BUILD_SH, '--out', lib, '--allow-dirty'], {
    cwd: ROOT,
    env,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  if (p.exitCode !== 0) throw new Error(`build failed: ${p.stderr.toString()}`)
  const m = /^BUILD \S+ -> (\S+)$/m.exec(p.stdout.toString())
  if (!m) throw new Error(`no BUILD line: ${p.stdout.toString()}`)
  return m[1]
}

function inst(
  build: string,
  home: string,
  args: string[] = [],
  extraEnv: Record<string, string> = {}
): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(['bash', join(build, 'install.sh'), ...args], {
    env: {
      ...process.env,
      HOME: home,
      FANOUT_INSTALL_NO_SYSTEMD: '1',
      ...extraEnv
    } as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() }
}

function backupDir(home: string): string {
  const dirs = readdirSync(join(home, '.agents/backups')).filter((d) => d.startsWith('fanout-install-'))
  expect(dirs.length).toBeGreaterThan(0)
  return join(home, '.agents/backups', dirs.sort().at(-1)!)
}

test('links and modes', () => {
  const { home } = setupHome()
  const build = makeBuild(home)
  const r = inst(build, home)
  expect(r.code, r.stderr).toBe(0)
  expect(readlink(join(home, '.local/lib/agent-ops/fanout/current'))).toBe(build)
  expect(readlink(join(home, '.agents/bin/fanout'))).toBe(join(build, 'fanout'))
  expect(readlink(join(home, '.local/bin/fanout'))).toBe(join(build, 'fanout'))
  expect(statSync(join(home, '.local/share/agent-ops/fanout')).mode & 0o777).toBe(0o700)
  expect(statSync(join(home, '.config/agent-ops')).mode & 0o777).toBe(0o700)
})

function readlink(p: string): string {
  return Bun.spawnSync(['readlink', '-f', p]).stdout.toString().trim()
}

test('the live path is the built copy, not the checkout', () => {
  const { home } = setupHome()
  const build = makeBuild(home)
  expect(inst(build, home).code).toBe(0)
  for (const p of [
    '.local/lib/agent-ops/fanout/current',
    '.agents/bin/fanout',
    '.local/bin/fanout',
    '.claude/skills/fanout',
    '.agents/skills/fanout'
  ])
    expect(readlink(join(home, p)).startsWith(ROOT), p).toBe(false)
})

test('the PATH block is idempotent', () => {
  const { home } = setupHome()
  const build = makeBuild(home)
  expect(inst(build, home).code).toBe(0)
  const firstBashrc = readFileSync(join(home, '.bashrc'), 'utf8')
  const firstProfile = readFileSync(join(home, '.profile'), 'utf8')
  expect(inst(build, home).code).toBe(0)
  expect(readFileSync(join(home, '.bashrc'), 'utf8')).toBe(firstBashrc)
  expect(readFileSync(join(home, '.profile'), 'utf8')).toBe(firstProfile)
  expect(firstBashrc.split('# >>> fanout PATH >>>').length - 1).toBe(1)
  expect(firstProfile.split('# >>> fanout PATH >>>').length - 1).toBe(1)
  const guardIdx = firstBashrc.indexOf('case $- in')
  expect(firstBashrc.indexOf('# >>> fanout PATH >>>')).toBeLessThan(guardIdx)
})

test('edited files are backed up', () => {
  const { home, bashrc, profile } = setupHome()
  const build = makeBuild(home)
  expect(inst(build, home).code).toBe(0)
  const dir = backupDir(home)
  expect(readFileSync(join(dir, 'bashrc'), 'utf8')).toBe(bashrc)
  expect(readFileSync(join(dir, 'profile'), 'utf8')).toBe(profile)
})

test('the shim works through the link with a clean environment', () => {
  const { home } = setupHome()
  const build = makeBuild(home)
  expect(inst(build, home).code).toBe(0)
  mkdirSync(join(home, '.bun/bin'), { recursive: true })
  symlinkSync(process.execPath, join(home, '.bun/bin/bun'))
  const p = Bun.spawnSync([join(home, '.local/bin/fanout'), '--version'], {
    env: { HOME: home, PATH: `${join(home, '.local/bin')}:/usr/bin:/bin` },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  expect(p.exitCode).toBe(0)
  expect(p.stdout.toString().trim()).toBe('fanout 0.1.0')
})

test('skills are linked and an existing directory is kept', () => {
  const { home } = setupHome()
  const build = makeBuild(home)
  const real = join(home, '.claude/skills/fanout')
  mkdirSync(real, { recursive: true })
  writeFileSync(join(real, 'old.txt'), 'old\n')
  expect(inst(build, home).code).toBe(0)
  expect(readFileSync(join(home, '.claude/skills/fanout/SKILL.md'), 'utf8')).toContain('name: fanout')
  expect(readFileSync(join(home, '.agents/skills/fanout/SKILL.md'), 'utf8')).toContain('name: fanout')
  expect(readlink(join(home, '.claude/skills/fanout'))).toBe(join(build, 'skill'))
  const found = Bun.spawnSync(['find', backupDir(home), '-name', 'old.txt'], {
    stdout: 'pipe'
  })
    .stdout.toString()
    .trim()
  expect(found).toContain('old.txt')
})

test('a newer build switches the link and old builds are pruned', () => {
  const { home } = setupHome()
  const builds = [
    makeBuild(home, '2026-11-15T01:00:00Z'),
    makeBuild(home, '2026-11-15T01:01:00Z'),
    makeBuild(home, '2026-11-15T01:02:00Z'),
    makeBuild(home, '2026-11-15T01:03:00Z')
  ]
  for (const b of builds) expect(inst(b, home).code).toBe(0)
  expect(readlink(join(home, '.local/lib/agent-ops/fanout/current'))).toBe(builds[3])
  const remain = readdirSync(join(home, '.local/lib/agent-ops/fanout')).filter(
    (d) => d !== 'current' && statSync(join(home, '.local/lib/agent-ops/fanout', d)).isDirectory()
  )
  expect(remain.length).toBe(3)
  expect(remain.map((d) => join(home, '.local/lib/agent-ops/fanout', d)).sort()).toEqual(builds.slice(1).sort())
})

test('a rollback is a re-install of an older build', () => {
  const { home } = setupHome()
  const builds = [
    makeBuild(home, '2026-11-15T01:00:00Z'),
    makeBuild(home, '2026-11-15T01:01:00Z'),
    makeBuild(home, '2026-11-15T01:02:00Z'),
    makeBuild(home, '2026-11-15T01:03:00Z')
  ]
  for (const b of builds) expect(inst(b, home).code).toBe(0)
  expect(inst(builds[2], home).code).toBe(0)
  expect(readlink(join(home, '.local/lib/agent-ops/fanout/current'))).toBe(builds[2])
  const remain = readdirSync(join(home, '.local/lib/agent-ops/fanout')).filter(
    (d) => d !== 'current' && statSync(join(home, '.local/lib/agent-ops/fanout', d)).isDirectory()
  )
  expect(remain.length).toBe(3)
  expect(remain.map((d) => join(home, '.local/lib/agent-ops/fanout', d))).toContain(builds[3])
})

test('dry run changes nothing', () => {
  const { home } = setupHome()
  const build = makeBuild(home)
  expect(inst(build, home).code).toBe(0)
  const beforeList = snapshot(home)
  const r = inst(build, home, ['--dry-run'])
  expect(r.code).toBe(0)
  expect(r.stdout).toMatch(/^LINK /m)
  expect(r.stdout).toMatch(/^EDIT /m)
  expect(snapshot(home)).toEqual(beforeList)
})

function snapshot(home: string): string {
  const files: string[] = []
  const walkSafe = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      let st
      try {
        st = statSync(p)
      } catch {
        files.push(`${p.slice(home.length)}:link`)
        continue
      }
      if (st.isDirectory()) walkSafe(p)
      else files.push(`${p.slice(home.length)}:${st.isFile() ? `${st.size}:${st.mode & 0o777}` : 'other'}`)
    }
  }
  walkSafe(home)
  return files.sort().join('\n')
}

test('instruction files, settings and docs are untouched', () => {
  const { home } = setupHome()
  mkdirSync(join(home, '.agents'), { recursive: true })
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.agents/AGENTS.md'), '# agents\n')
  writeFileSync(join(home, '.claude/CLAUDE.md'), '# claude\n')
  writeFileSync(join(home, '.claude/settings.json'), '{}\n')
  const build = makeBuild(home)
  expect(inst(build, home).code).toBe(0)
  expect(readFileSync(join(home, '.agents/AGENTS.md'), 'utf8')).toBe('# agents\n')
  expect(readFileSync(join(home, '.claude/CLAUDE.md'), 'utf8')).toBe('# claude\n')
  expect(readFileSync(join(home, '.claude/settings.json'), 'utf8')).toBe('{}\n')
})
