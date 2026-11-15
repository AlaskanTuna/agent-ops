import { test } from 'bun:test'
import { expect } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const MINE = resolve(import.meta.dir, '../tools/mine/mine.ts')
const REPO = resolve(import.meta.dir, '../..')
const HAVE_DUCKDB = !!Bun.which('duckdb')
const t = HAVE_DUCKDB ? test : test.skip

const HOME_FAKE = '/' + 'home/someone'
const KEY = 'sk-' + 'k'.repeat(24)
const EMAIL = 'bob' + '@example.com'

function errText(req: string, uuid: string): string {
  return `ERROR: You've hit your usage limit. Try again at 9:15 PM. Contact ${EMAIL}. key ${KEY} at ${HOME_FAKE}/proj/a.ts ${req} id ${uuid}`
}

function useMsg(id: string, command: string, background: boolean, session: string): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: session,
    timestamp: '2026-11-15T01:00:00.000Z',
    message: {
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command, run_in_background: background } }]
    }
  })
}

function resultMsg(id: string, text: string, isError = true): string {
  return JSON.stringify({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: [{ type: 'text', text }] }]
    }
  })
}

function makeDb(db: string, rows: { file: string; session: string; cmds: string[] }[]): void {
  const values = rows
    .map(
      (r) =>
        `('${r.file.replace(/'/g, "''")}', '${r.session}', [${r.cmds.map((c) => `'${c.replace(/'/g, "''")}'`).join(', ')}])`
    )
    .join(', ')
  const p = Bun.spawnSync(
    [
      'duckdb',
      '-no-agent',
      db,
      `CREATE TABLE ev(file VARCHAR, sessionId VARCHAR, cmds VARCHAR[]); INSERT INTO ev VALUES ${values};`
    ],
    {
      stdout: 'pipe',
      stderr: 'pipe'
    }
  )
  if (p.exitCode !== 0) throw new Error(`duckdb setup failed: ${p.stderr.toString()}`)
}

function writeTranscript(projects: string, name: string, lines: string[]): string {
  mkdirSync(projects, { recursive: true })
  const p = join(projects, name)
  writeFileSync(p, lines.map((l) => l + '\n').join(''))
  return p
}

function runMine(
  db: string,
  projects: string,
  rawOut: string,
  out: string,
  extra: string[] = []
): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(
    ['bun', MINE, '--db', db, '--projects', projects, '--raw-out', rawOut, '--out', out, ...extra],
    {
      cwd: REPO,
      stdout: 'pipe',
      stderr: 'pipe'
    }
  )
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() }
}

function freshDirs(): { db: string; projects: string; rawOut: string; out: string } {
  const base = mkdtempSync(join(tmpdir(), 'mine-test-'))
  return {
    db: join(base, 'ev.duckdb'),
    projects: join(base, 'projects'),
    rawOut: join(base, 'raw'),
    out: join(base, 'out')
  }
}

function outFiles(out: string): string[] {
  const found: string[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else found.push(p)
    }
  }
  walk(out)
  return found.sort()
}

function treeSnapshot(dir: string): Record<string, string> {
  const snap: Record<string, string> = {}
  const walk = (d: string, prefix: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name)
      const key = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) walk(p, key)
      else snap[key] = readFileSync(p, 'utf8')
    }
  }
  if (existsSync(dir)) walk(dir, '')
  return snap
}

const CODEX_CMD = `codex exec -C ${HOME_FAKE}/proj -m gpt-6-luna - < ${HOME_FAKE}/b.md`

function setupForeground(): { db: string; projects: string; rawOut: string; out: string } {
  const d = freshDirs()
  const f1 = writeTranscript(d.projects, 's1.jsonl', [
    useMsg('toolu_AAA111', CODEX_CMD, false, 'S1'),
    resultMsg('toolu_AAA111', errText('req_01HZYABCDEFGH1000', '123e4567-e89b-12d3-a456-426614174000'))
  ])
  const f2 = writeTranscript(d.projects, 's2.jsonl', [
    useMsg('toolu_BBB222', CODEX_CMD, false, 'S2'),
    resultMsg('toolu_BBB222', errText('req_01HZYABCDEFGH2000', '123e4567-e89b-12d3-a456-426614174001'))
  ])
  makeDb(d.db, [
    { file: f1, session: 'S1', cmds: [CODEX_CMD] },
    { file: f2, session: 'S2', cmds: [CODEX_CMD] }
  ])
  return d
}

t('a foreground launch is paired and clustered', () => {
  const d = setupForeground()
  const r = runMine(d.db, d.projects, d.rawOut, d.out)
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('MINED codex pairs=2 clusters=1')
  const index = JSON.parse(readFileSync(join(d.out, 'codex', 'index.json'), 'utf8')) as {
    id: string
    file: string
    signature: string
    count: number
    sessions: number
    outcome: null
  }[]
  expect(index).toHaveLength(1)
  expect(index[0]).toMatchObject({ count: 2, sessions: 2, outcome: null })
  const fixture = readFileSync(join(d.out, 'codex', index[0].file), 'utf8')
  expect(fixture).toContain('hit your usage limit')
})

t('scrubbing removes ids, paths, emails and keys', () => {
  const d = setupForeground()
  const r = runMine(d.db, d.projects, d.rawOut, d.out)
  expect(r.code).toBe(0)
  for (const f of outFiles(d.out)) {
    const c = readFileSync(f, 'utf8')
    expect(c).not.toContain(EMAIL)
    expect(c).not.toContain(KEY)
    expect(c).not.toContain(HOME_FAKE)
    expect(c).not.toContain('req_01HZ')
    expect(c).not.toContain('toolu_')
    expect(c).not.toContain('123e4567')
  }
  const index = JSON.parse(readFileSync(join(d.out, 'codex', 'index.json'), 'utf8')) as { signature: string }[]
  expect(index[0].signature).toContain('<email>')
  expect(index[0].signature).toContain('<path>')
})

t('the raw output stays outside the repository', () => {
  const d = setupForeground()
  const r = runMine(d.db, d.projects, d.rawOut, d.out)
  expect(r.code).toBe(0)
  const pairs = readFileSync(join(d.rawOut, 'pairs.jsonl'), 'utf8').trim().split('\n')
  expect(pairs).toHaveLength(2)
  expect(readFileSync(join(d.rawOut, 'pairs.jsonl'), 'utf8')).toContain(EMAIL)
  const bad = runMine(d.db, d.projects, join(REPO, 'tmp-raw'), join(d.out, 'out2'))
  expect(bad.code).toBe(2)
  expect(bad.stderr).toContain('raw output must be outside the repository')
  expect(existsSync(join(REPO, 'tmp-raw'))).toBe(false)
})

t('a background launch is paired through the later read', () => {
  const d = freshDirs()
  const f = writeTranscript(d.projects, 'bg.jsonl', [
    useMsg('toolu_AAA111', CODEX_CMD, true, 'S1'),
    resultMsg(
      'toolu_AAA111',
      'Command running in background with ID: bk1. Output is being written to: /tmp/x/tasks/bk1.output',
      false
    ),
    useMsg('toolu_BBB222', 'tail -n 50 /tmp/x/tasks/bk1.output', false, 'S1'),
    resultMsg('toolu_BBB222', errText('req_01HZYABCDEFGH1000', '123e4567-e89b-12d3-a456-426614174000')),
    JSON.stringify({
      type: 'queue-operation',
      content:
        '<task-notification><task-id>bk1</task-id><tool-use-id>toolu_AAA111</tool-use-id><status>failed</status><summary>Background command "x" failed (exit code 1)</summary></task-notification>'
    })
  ])
  makeDb(d.db, [{ file: f, session: 'S1', cmds: [CODEX_CMD] }])
  const r = runMine(d.db, d.projects, d.rawOut, d.out)
  expect(r.code).toBe(0)
  const pairs = readFileSync(join(d.rawOut, 'pairs.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
  expect(pairs).toHaveLength(1)
  expect(pairs[0]).toMatchObject({ via: 'later_read', exit: 1 })
  expect(String(pairs[0].text)).toContain('usage limit')
})

t('every harness is recognised', () => {
  const d = freshDirs()
  const cmds: [string, string][] = [
    ['agy', 'agy -p "$(<b.md)" --model gemini-4-hydrogen --effort medium --add-dir /x'],
    ['meta', '"$HOME/CS/meta-fanout/worker.sh" b.md l.log'],
    ['opencode', 'opencode run --model opencode/x --dir . "$(cat b.md)" < /dev/null'],
    ['modelscope', 'python3 ~/.claude/skills/modelscope-fanout/scripts/worker.py --cwd . --brief b.md'],
    ['river', 'ANTHROPIC_BASE_URL=http://127.0.0.1:8317 ANTHROPIC_MODEL=deepseek-v4.1-flash-river claude -p "do x"'],
    ['claude-fanout', 'ANTHROPIC_BASE_URL=http://127.0.0.1:8317 ANTHROPIC_MODEL=glm-5.3-flash claude -p "do x"']
  ]
  const lines: string[] = []
  const dbCmds: string[] = []
  cmds.forEach(([h, cmd], i) => {
    const id = `toolu_H${i}00`
    lines.push(useMsg(id, cmd, false, 'S9'))
    lines.push(resultMsg(id, `Error: quota exceeded (${h})`))
    dbCmds.push(cmd)
  })
  const f = writeTranscript(d.projects, 'all.jsonl', lines)
  makeDb(d.db, [{ file: f, session: 'S9', cmds: dbCmds }])
  const r = runMine(d.db, d.projects, d.rawOut, d.out)
  expect(r.code).toBe(0)
  for (const [h] of cmds) expect(r.stdout).toContain(`MINED ${h} pairs=1`)
})

t('other commands are ignored', () => {
  const d = freshDirs()
  const f = writeTranscript(d.projects, 'mix.jsonl', [
    useMsg('toolu_AAA111', CODEX_CMD, false, 'S1'),
    resultMsg('toolu_AAA111', errText('req_01HZYABCDEFGH1000', '123e4567-e89b-12d3-a456-426614174000')),
    useMsg('toolu_CCC333', 'ls -la', false, 'S1'),
    resultMsg('toolu_CCC333', 'total 0\ndrwxr-xr-x a.txt', false)
  ])
  makeDb(d.db, [{ file: f, session: 'S1', cmds: [CODEX_CMD, 'ls -la'] }])
  const r = runMine(d.db, d.projects, d.rawOut, d.out)
  expect(r.code).toBe(0)
  const mined = r.stdout.split('\n').filter((l) => l.startsWith('MINED'))
  expect(mined.length).toBeGreaterThan(0)
  for (const l of mined) expect(l.startsWith('MINED codex')).toBe(true)
})

t('a transcript that no longer exists is skipped', () => {
  const d = freshDirs()
  mkdirSync(d.projects, { recursive: true })
  makeDb(d.db, [{ file: join(d.projects, 'gone.jsonl'), session: 'S1', cmds: [CODEX_CMD] }])
  const r = runMine(d.db, d.projects, d.rawOut, d.out)
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('SKIPPED files=1')
})

t('the output is deterministic', () => {
  const d = setupForeground()
  const out2 = join(d.out, '..', 'out2')
  const raw2 = join(d.rawOut, '..', 'raw2')
  const r1 = runMine(d.db, d.projects, d.rawOut, d.out)
  const r2 = runMine(d.db, d.projects, raw2, out2)
  expect(r1.code).toBe(0)
  expect(r2.code).toBe(0)
  expect(treeSnapshot(out2)).toEqual(treeSnapshot(d.out))
})
