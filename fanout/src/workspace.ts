import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { dataDir, runDir } from './paths'

export interface Workspace {
  cwd: string
  mode: 'git' | 'plain'
  worktree?: string
  baseSha?: string
  changedFiles(): string[] | 'unknown'
  finish(job: string): { patch?: string }
}

interface GitOpts {
  top: string
  rel: string
  sha: string
  worktree: string
}

function git(top: string, args: string[], extraEnv?: Record<string, string>): { code: number; out: string } {
  const p = Bun.spawnSync(['git', '-C', top, ...args], {
    env: { ...process.env, ...extraEnv },
    stdout: 'pipe',
    stderr: 'ignore'
  })
  return { code: p.exitCode, out: p.stdout.toString().trim() }
}

function toplevel(dir: string): string | undefined {
  const p = Bun.spawnSync(['git', '-C', dir, 'rev-parse', '--show-toplevel'], {
    stdout: 'pipe',
    stderr: 'ignore'
  })
  if (p.exitCode !== 0) return undefined
  const top = p.stdout.toString().trim()
  return top || undefined
}

function snapshot(top: string, root: string): string | undefined {
  const indexDir = mkdtempSync(join(tmpdir(), 'fanout-index-'))
  const indexFile = join(indexDir, 'index')
  const gitEnv = {
    GIT_INDEX_FILE: indexFile,
    GIT_AUTHOR_NAME: 'fanout',
    GIT_AUTHOR_EMAIL: 'fanout@localhost',
    GIT_COMMITTER_NAME: 'fanout',
    GIT_COMMITTER_EMAIL: 'fanout@localhost'
  }
  try {
    const head = git(top, ['rev-parse', 'HEAD'])
    const unborn = head.code !== 0
    if (!unborn) {
      const rt = git(top, ['read-tree', 'HEAD'], gitEnv)
      if (rt.code !== 0) return undefined
    }
    if (git(top, ['add', '-A'], gitEnv).code !== 0) return undefined
    const tree = git(top, ['write-tree'], gitEnv)
    if (tree.code !== 0 || !tree.out) return undefined
    const ctArgs = unborn
      ? ['commit-tree', tree.out, '-m', `fanout snapshot ${root}`]
      : ['commit-tree', tree.out, '-p', 'HEAD', '-m', `fanout snapshot ${root}`]
    const ct = git(top, ctArgs, gitEnv)
    if (ct.code !== 0 || !ct.out) return undefined
    if (git(top, ['update-ref', `refs/fanout/${root}`, ct.out]).code !== 0) return undefined
    return ct.out
  } finally {
    try {
      rmSync(indexDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

function gitWorkspace(o: GitOpts): Workspace {
  const cwd = o.rel ? join(o.worktree, o.rel) : o.worktree
  try {
    mkdirSync(cwd, { recursive: true })
  } catch {
    // ignore
  }
  return {
    cwd,
    mode: 'git',
    worktree: o.worktree,
    baseSha: o.sha,
    changedFiles(): string[] | 'unknown' {
      const st = git(o.worktree, ['status', '--porcelain=v1'])
      if (st.code !== 0) return 'unknown'
      const files = st.out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) =>
          l
            .slice(3)
            .trim()
            .replace(/^"(.*)"$/, '$1')
        )
      return files
    },
    finish(job: string): { patch?: string } {
      if (git(o.worktree, ['add', '-A']).code !== 0) return {}
      const diff = Bun.spawnSync(['git', '-C', o.worktree, 'diff', '--cached', '--binary', o.sha], {
        stdout: 'pipe',
        stderr: 'ignore'
      })
      if (diff.exitCode !== 0) return {}
      try {
        mkdirSync(join(dataDir(), 'patches'), { recursive: true, mode: 0o700 })
        const patchPath = join(dataDir(), 'patches', `${job}.patch`)
        writeFileSync(patchPath, diff.stdout.toString(), { mode: 0o600 })
        return { patch: patchPath }
      } catch {
        return {}
      }
    }
  }
}

function walkManifest(dir: string, base: string, out: Map<string, string>, cap: number): boolean {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return false
  }
  for (const e of entries.sort()) {
    if (e === '.git' || e === 'node_modules') continue
    const full = join(dir, e)
    const rel = base ? `${base}/${e}` : e
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (walkManifest(full, rel, out, cap)) return true
    } else if (st.isFile()) {
      if (out.size >= cap) return true
      out.set(rel, `${st.size}:${st.mtimeMs}`)
    }
  }
  return false
}

function plainWorkspace(dir: string): Workspace {
  const before = new Map<string, string>()
  const cappedAtStart = walkManifest(dir, '', before, 5000)
  void cappedAtStart
  return {
    cwd: dir,
    mode: 'plain',
    changedFiles(): string[] | 'unknown' {
      const after = new Map<string, string>()
      const capped = walkManifest(dir, '', after, 5000)
      if (capped || before.size >= 5000) return 'unknown'
      const changed: string[] = []
      for (const [k, v] of after) {
        if (before.get(k) !== v) changed.push(k)
      }
      for (const k of before.keys()) {
        if (!after.has(k)) changed.push(k)
      }
      return changed
    },
    finish(_job: string): { patch?: string } {
      return {}
    }
  }
}

export function openWorkspace(dir: string, root: string, job: string, attempt: number): Workspace {
  const top = toplevel(dir)
  if (!top) return plainWorkspace(dir)
  const sha = snapshot(top, root)
  if (!sha) return plainWorkspace(dir)
  const rel = relative(top, dir) === '' ? '' : relative(top, dir)
  mkdirSync(join(dataDir(), 'worktrees'), { recursive: true, mode: 0o700 })
  try {
    mkdirSync(runDir(), { recursive: true, mode: 0o700 })
  } catch {
    // ignore
  }
  const worktree = join(dataDir(), 'worktrees', `${job}-a${attempt}`)
  const wt = git(top, ['worktree', 'add', '--detach', worktree, sha])
  if (wt.code !== 0) return plainWorkspace(dir)
  try {
    writeFileSync(`${worktree}.fanout-repo`, top)
  } catch {
    // marker failures never break a run
  }
  return gitWorkspace({ top, rel, sha, worktree })
}
