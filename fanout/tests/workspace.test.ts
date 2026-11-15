import { test, expect } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { sandbox } from './helpers/sandbox'

const RUN = (sb: ReturnType<typeof sandbox>) => [
  'run',
  '--brief',
  sb.brief('Rename foo in a.txt to bar, nothing else.'),
  '--dir',
  sb.repo,
  '--kind',
  'transcribe'
]

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
  }).trim()
}

function line(r: { stdout: string }, prefix: string): string {
  const found = r.stdout.split('\n').find((l) => l.startsWith(prefix))
  if (!found) throw new Error(`no ${prefix} line in stdout:\n${r.stdout}`)
  return found.slice(prefix.length)
}

/** A repo with a committed-then-edited file, an untracked file, and an ignored file. */
function dirtyRepo(sb: ReturnType<typeof sandbox>): void {
  writeFileSync(join(sb.repo, 'dirty.txt'), 'v1\n')
  git(sb.repo, ['add', 'dirty.txt'])
  git(sb.repo, ['commit', '-qm', 'add dirty'])
  writeFileSync(join(sb.repo, 'dirty.txt'), 'v1\nuncommitted edit\n')
  writeFileSync(join(sb.repo, 'untracked.txt'), 'untracked\n')
  writeFileSync(join(sb.repo, '.gitignore'), 'ignored.log\n')
  writeFileSync(join(sb.repo, 'ignored.log'), 'ignore me\n')
}

test('worker sees tracked-modified and untracked files, not ignored ones', async () => {
  const sb = sandbox()
  dirtyRepo(sb)
  sb.script({ 'fake/f1-a': ['ok'] })
  const r = await sb.fanout(RUN(sb))
  expect(r.code).toBe(0)
  const patch = readFileSync(line(r, 'PATCH='), 'utf8')
  expect(patch).toContain('+++ b/seen.txt')
  expect(patch).toMatch(/\+dirty\.txt/)
  expect(patch).toMatch(/\+untracked\.txt/)
  expect(patch).not.toMatch(/ignored\.log/)
}, 30000)

test('the caller checkout is untouched', async () => {
  const sb = sandbox()
  dirtyRepo(sb)
  sb.script({ 'fake/f1-a': ['ok'] })
  const before = [
    git(sb.repo, ['status', '--porcelain=v2']),
    git(sb.repo, ['rev-parse', 'HEAD']),
    git(sb.repo, ['stash', 'list'])
  ]
  const r = await sb.fanout(RUN(sb))
  expect(r.code).toBe(0)
  expect([
    git(sb.repo, ['status', '--porcelain=v2']),
    git(sb.repo, ['rev-parse', 'HEAD']),
    git(sb.repo, ['stash', 'list'])
  ]).toEqual(before)
  expect(readFileSync(join(sb.repo, 'dirty.txt'), 'utf8')).toBe('v1\nuncommitted edit\n')
}, 30000)

test('layout', async () => {
  const sb = sandbox()
  dirtyRepo(sb)
  sb.script({ 'fake/f1-a': ['ok'] })
  const r = await sb.fanout(RUN(sb))
  expect(r.code).toBe(0)
  const worktree = line(r, 'WORKTREE=')
  expect(worktree.startsWith(join(sb.home, 'worktrees', ''))).toBe(true)
  expect(worktree.endsWith('-a1')).toBe(true)
  expect(readFileSync(`${worktree}.fanout-repo`, 'utf8')).toBe(sb.repo)
  const patch = readFileSync(line(r, 'PATCH='), 'utf8')
  expect(patch).not.toContain('.fanout-repo')
  const root = sb.ledger().find((e) => e.event === 'job_start')?.root as string
  expect(git(sb.repo, ['for-each-ref', '--format=%(refname)', 'refs/fanout/'])).toBe(`refs/fanout/${root}`)
}, 30000)

test('the patch applies to the original repo', async () => {
  const sb = sandbox()
  dirtyRepo(sb)
  sb.script({ 'fake/f1-a': ['ok'] })
  const r = await sb.fanout(RUN(sb))
  expect(r.code).toBe(0)
  git(sb.repo, ['apply', '--check', line(r, 'PATCH=')])
}, 30000)

test('--dir inside a subfolder', async () => {
  const sb = sandbox()
  mkdirSync(join(sb.repo, 'sub'), { recursive: true })
  writeFileSync(join(sb.repo, 'sub', 'keep.txt'), 'keep\n')
  sb.script({ 'fake/f1-a': ['ok'] })
  const r = await sb.fanout(['run', '--brief', sb.brief(), '--dir', join(sb.repo, 'sub'), '--kind', 'transcribe'])
  expect(r.code).toBe(0)
  const patch = readFileSync(line(r, 'PATCH='), 'utf8')
  expect(patch).toContain('+++ b/sub/seen.txt')
}, 30000)

test('a non-git directory runs in place', async () => {
  const sb = sandbox()
  const plain = join(sb.home, 'plain')
  mkdirSync(plain, { recursive: true })
  writeFileSync(join(plain, 'note.txt'), 'note\n')
  sb.script({ 'fake/f1-a': ['ok'] })
  const r = await sb.fanout(['run', '--brief', sb.brief(), '--dir', plain, '--kind', 'transcribe'])
  expect(r.code).toBe(0)
  expect(existsSync(join(plain, 'out.txt'))).toBe(true)
  expect(r.stdout).not.toContain('WORKTREE=')
  expect(r.stdout).not.toContain('PATCH=')
}, 30000)

test('job_start records the workspace', async () => {
  const sb = sandbox()
  sb.script({ 'fake/f1-a': ['ok'] })
  const r = await sb.fanout(RUN(sb))
  expect(r.code).toBe(0)
  const start = sb.ledger().find((e) => e.event === 'job_start')
  expect(start?.workspace as string).toMatch(/worktrees\/.+-a1$/)
  const root = start?.root as string
  expect(start?.base_sha).toBe(git(sb.repo, ['rev-parse', `refs/fanout/${root}`]))
}, 30000)

test('an unborn repo works', async () => {
  const sb = sandbox()
  const fresh = join(sb.home, 'fresh')
  mkdirSync(fresh, { recursive: true })
  git(fresh, ['init', '-q'])
  writeFileSync(join(fresh, 'first.txt'), 'first\n')
  sb.script({ 'fake/f1-a': ['ok'] })
  const r = await sb.fanout(['run', '--brief', sb.brief(), '--dir', fresh, '--kind', 'transcribe'])
  expect(r.code).toBe(0)
  const patch = readFileSync(line(r, 'PATCH='), 'utf8')
  expect(patch).toContain('+++ b/seen.txt')
  expect(patch).toMatch(/first\.txt/)
}, 30000)
