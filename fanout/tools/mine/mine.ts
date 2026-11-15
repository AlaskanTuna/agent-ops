// One-off dev tool: mine fanout error texts from Claude Code transcripts.
//
// Usage:
//   bun fanout/tools/mine/mine.ts --db <duckdb file> --projects <dir> --raw-out <dir> --out <dir> [--min-count 2]
//
// Reads the ev table for candidate transcript files (see pairs.sql), pairs each fanout
// launch with its tool result (foreground directly, background through later reads of
// tasks/<task>.output or BashOutput/TaskOutput plus the queue-operation notification),
// then clusters scrubbed candidate lines per harness. Writes scrubbed fixtures and
// index.json files under --out, full unscrubbed pairs under --raw-out (which must be
// outside the repository). Not shipped in the built copy; does not change the CLI.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { normalizeSignature, scrubFixture } from '../../src/scrub'

type Harness = 'codex' | 'agy' | 'meta' | 'modelscope' | 'opencode' | 'river' | 'claude-fanout'

interface Pair {
  harness: Harness
  session: string
  ts: string | null
  via: 'direct' | 'later_read'
  is_error: boolean
  exit: number | null
  text: string
}

interface Launch {
  harness: Harness
  session: string
  ts: string | null
  background: boolean
}

interface PendingBg {
  launch: Launch
  texts: string[]
  isError: boolean
  exit: number | null
}

const CANDIDATE =
  /error|fail|limit|quota|exhaust|denied|unauthor|forbidden|\b[45]\d\d\b|timeout|timed out|rate|credit|insufficient|unavailable|not found|invalid|deprecated|cancel|context|max.turns|refus/i

// Same leak shapes as fanout/tests/hygiene.test.ts: a fixture matching any of
// these is refused (exit 1). The @example exemptions match hygiene's scrubbed().
const LEAK_RULES: [string, RegExp][] = [
  ['absolute home path', /\/home\/[a-z]|\/Users\/|C:\\Users/],
  ['email address', /[\w.+-]+@[\w-]+\.[a-z]{2,}/],
  ['api key shape', /\bAIza[\w-]{30,}|\bsk-[\w-]{16,}|Bearer [\w.-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY/],
  ['secret assignment', /(api[_-]?key|token|secret|password)\s*[=:]\s*["']?[\w-]{20,}/]
]

function scrubbedExemptions(content: string): string {
  return content
    .replace(/@users\.noreply\.github\.com/g, '')
    .replace(/@example\.com/g, '')
    .replace(/@example\.invalid/g, '')
}

function fail(msg: string, code: number): never {
  process.stderr.write(msg + '\n')
  process.exit(code)
}

function opt(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined
}

function repoRoot(): string {
  const p = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
    cwd: import.meta.dir,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  if (p.exitCode === 0) return p.stdout.toString().trim()
  return resolve(import.meta.dir, '..', '..', '..')
}

function loadDenylist(): RegExp[] {
  const p = join(import.meta.dir, '..', '..', 'patterns', 'denylist.json')
  if (!existsSync(p)) return []
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as { lines?: string[] }
    return (raw.lines ?? []).map((s) => new RegExp(s))
  } catch {
    return []
  }
}

export function classifyLaunch(cmd: string): Harness | undefined {
  if (/\bcodex\s+exec\b/.test(cmd)) return 'codex'
  if (/\bagy\b.*\s(-p|--print)\b/.test(cmd)) return 'agy'
  if (/meta-fanout\/worker\.sh/.test(cmd)) return 'meta'
  if (/modelscope-fanout\/scripts\/worker\.py/.test(cmd)) return 'modelscope'
  if (/\bopencode\s+run\b/.test(cmd)) return 'opencode'
  if (/\bclaude\s+-p\b/.test(cmd)) {
    if (!/8317|CLIPROXY/.test(cmd)) return undefined
    if (/[\w.+-]*-river\b/.test(cmd)) return 'river'
    return 'claude-fanout'
  }
  return undefined
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => {
      if (typeof b === 'string') return b
      if (b && typeof b === 'object') {
        const o = b as Record<string, unknown>
        if (typeof o.text === 'string') return o.text
      }
      return ''
    })
    .join('\n')
}

interface Blocks {
  uses: { id: string; name: string; input: Record<string, unknown> }[]
  results: { toolUseId: string; isError: boolean; text: string }[]
}

function blocksIn(node: unknown): Blocks {
  const out: Blocks = { uses: [], results: [] }
  if (!node || typeof node !== 'object') return out
  const o = node as Record<string, unknown>
  const push = (b: unknown): void => {
    if (!b || typeof b !== 'object') return
    const r = b as Record<string, unknown>
    if (r.type === 'tool_use' && typeof r.id === 'string') {
      out.uses.push({
        id: r.id,
        name: typeof r.name === 'string' ? r.name : '',
        input: (r.input ?? {}) as Record<string, unknown>
      })
    } else if (r.type === 'tool_result' && typeof r.tool_use_id === 'string') {
      out.results.push({ toolUseId: r.tool_use_id, isError: r.is_error === true, text: contentText(r.content) })
    }
  }
  const containers: unknown[] = [o.tool_use, o.tool_result, o.content, o.message]
  for (const c of containers) {
    if (Array.isArray(c)) for (const b of c) push(b)
    else if (c && typeof c === 'object' && Array.isArray((c as Record<string, unknown>).content)) {
      for (const b of (c as Record<string, unknown>).content as unknown[]) push(b)
    } else push(c)
  }
  return out
}

function parseNotification(
  content: string
): { taskId: string; toolUseId: string; status: string; exit: number | null } | undefined {
  if (!content.includes('<task-notification>')) return undefined
  const pick = (tag: string): string => {
    const m = content.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
    return m ? m[1].trim() : ''
  }
  const summary = pick('summary')
  const exitMatch = summary.match(/\(exit code (\d+)\)/)
  return {
    taskId: pick('task-id'),
    toolUseId: pick('tool-use-id'),
    status: pick('status'),
    exit: exitMatch ? Number(exitMatch[1]) : null
  }
}

function parsePairs(lines: string[], fallbackSession: string): Pair[] {
  const pairs: Pair[] = []
  const launches = new Map<string, { launch: Launch; command: string }>()
  const commands = new Map<string, string>()
  const taskInputs = new Map<string, string>()
  const pending = new Map<string, PendingBg>()

  for (const line of lines) {
    if (!line.trim()) continue
    let node: Record<string, unknown>
    try {
      node = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (node.type === 'queue-operation' && typeof node.content === 'string') {
      const n = parseNotification(node.content)
      if (n && n.taskId) {
        const pend = pending.get(n.taskId)
        if (pend) {
          if (n.exit !== null) pend.exit = n.exit
          if (n.status && n.status !== 'completed') pend.isError = true
        } else if (n.toolUseId) {
          const found = launches.get(n.toolUseId)
          if (found && found.launch.background) {
            pending.set(n.taskId, {
              launch: found.launch,
              texts: [],
              isError: n.status !== '' && n.status !== 'completed',
              exit: n.exit
            })
          }
        }
      }
      continue
    }

    const session = typeof node.sessionId === 'string' && node.sessionId ? node.sessionId : fallbackSession
    const ts = typeof node.timestamp === 'string' ? node.timestamp : typeof node.ts === 'string' ? node.ts : null
    const { uses, results } = blocksIn(node)

    for (const u of uses) {
      const command = typeof u.input.command === 'string' ? u.input.command : ''
      const h = command ? classifyLaunch(command) : undefined
      if (h) {
        launches.set(u.id, {
          launch: { harness: h, session, ts, background: u.input.run_in_background === true },
          command
        })
      } else {
        if (command) commands.set(u.id, command)
        if (/^(BashOutput|TaskOutput)$/.test(u.name)) taskInputs.set(u.id, JSON.stringify(u.input))
      }
    }

    for (const r of results) {
      const found = launches.get(r.toolUseId)
      if (found) {
        if (found.launch.background) {
          const m = r.text.match(/background with ID:\s*([A-Za-z0-9_-]+)/)
          if (m) {
            pending.set(m[1], { launch: found.launch, texts: [], isError: false, exit: null })
          } else if (r.text.trim()) {
            pairs.push({ ...found.launch, via: 'direct', is_error: r.isError, exit: null, text: r.text })
          }
        } else if (r.text.trim()) {
          pairs.push({ ...found.launch, via: 'direct', is_error: r.isError, exit: null, text: r.text })
        }
        continue
      }
      const cmd = commands.get(r.toolUseId)
      const inputJson = taskInputs.get(r.toolUseId)
      for (const [taskId, pend] of pending) {
        if ((cmd && cmd.includes(`tasks/${taskId}.output`)) || (inputJson && inputJson.includes(taskId))) {
          if (r.text.trim()) pend.texts.push(r.text)
          pend.isError = pend.isError || r.isError
        }
      }
    }
  }

  for (const pend of pending.values()) {
    const text = pend.texts.join('\n')
    if (text.trim()) {
      pairs.push({ ...pend.launch, via: 'later_read', is_error: pend.isError, exit: pend.exit, text })
    }
  }
  return pairs
}

function clusterId(harness: string, signature: string): string {
  return createHash('sha256').update(`${harness}\n${signature}`).digest('hex').slice(0, 12)
}

function main(): void {
  const db = opt('--db')
  const projects = opt('--projects')
  const rawOut = opt('--raw-out')
  const out = opt('--out')
  const minCount = Number(opt('--min-count') ?? '2')
  if (!db || !projects || !rawOut || !out) {
    fail('usage: mine.ts --db <duckdb file> --projects <dir> --raw-out <dir> --out <dir> [--min-count 2]', 2)
  }

  const root = repoRoot()
  const rawResolved = resolve(rawOut)
  if (rawResolved === root || rawResolved.startsWith(root + sep)) {
    fail('raw output must be outside the repository', 2)
  }
  if (!Number.isFinite(minCount) || minCount < 1) fail('--min-count must be a positive integer', 2)

  const duckdb = Bun.which('duckdb')
  if (!duckdb) fail('duckdb not found on PATH', 1)
  const sql = readFileSync(join(import.meta.dir, 'pairs.sql'), 'utf8')
  const q = Bun.spawnSync([duckdb, '-no-agent', '-json', '-c', sql, db], { stdout: 'pipe', stderr: 'pipe' })
  if (q.exitCode !== 0) fail(`duckdb query failed: ${q.stderr.toString().trim()}`, 1)
  let rows: { file?: string; session?: string }[]
  try {
    rows = JSON.parse(q.stdout.toString()) as { file?: string; session?: string }[]
  } catch {
    fail('duckdb query did not return JSON', 1)
    rows = []
  }

  const denylist = loadDenylist()
  const seen = new Set<string>()
  const files: { file: string; session: string }[] = []
  for (const r of rows) {
    if (!r.file || seen.has(r.file)) continue
    seen.add(r.file)
    files.push({ file: r.file, session: r.session ?? 'unknown' })
  }
  files.sort((a, b) => a.file.localeCompare(b.file))

  let skipped = 0
  const pairs: Pair[] = []
  const launched = new Set<Harness>()
  for (const f of files) {
    if (!existsSync(f.file) || !statSync(f.file).isFile()) {
      skipped += 1
      continue
    }
    const lines = readFileSync(f.file, 'utf8').split('\n')
    const found = parsePairs(lines, f.session)
    for (const p of found) launched.add(p.harness)
    pairs.push(...found)
  }

  mkdirSync(rawResolved, { recursive: true })
  writeFileSync(
    join(rawResolved, 'pairs.jsonl'),
    pairs.map((p) => JSON.stringify(p)).join('\n') + (pairs.length ? '\n' : '')
  )

  const byPair = new Map<string, { harness: Harness; count: number; sessions: Set<string> }>()
  const fixtureLines = new Map<string, Set<string>>()
  pairs.forEach((p) => {
    const sigs = new Set<string>()
    for (const line of p.text.split('\n')) {
      if (!CANDIDATE.test(line)) continue
      if (denylist.some((re) => re.test(line))) continue
      sigs.add(normalizeSignature(scrubFixture(line)))
    }
    for (const sig of sigs) {
      const key = `${p.harness}\n${sig}`
      let c = byPair.get(key)
      if (!c) {
        c = { harness: p.harness, count: 0, sessions: new Set() }
        byPair.set(key, c)
      }
      c.count += 1
      c.sessions.add(p.session)
    }
  })

  const kept = [...byPair.entries()].filter(([, c]) => c.count >= minCount).sort(([a], [b]) => a.localeCompare(b))

  for (const [key] of kept) {
    const [harness, sig] = key.split('\n')
    const lines = new Set<string>()
    for (const p of pairs) {
      if (p.harness !== harness) continue
      for (const line of p.text.split('\n')) {
        if (!CANDIDATE.test(line)) continue
        if (denylist.some((re) => re.test(line))) continue
        if (normalizeSignature(scrubFixture(line)) === sig) lines.add(scrubFixture(line))
      }
    }
    fixtureLines.set(key, lines)
  }

  const perHarness = new Map<
    Harness,
    { id: string; file: string; signature: string; count: number; sessions: number }[]
  >()
  for (const [key, c] of kept) {
    const [harness, sig] = key.split('\n') as [Harness, string]
    const id = clusterId(harness, sig)
    const list = perHarness.get(harness) ?? []
    list.push({ id, file: `${id}.txt`, signature: sig, count: c.count, sessions: c.sessions.size })
    perHarness.set(harness, list)
  }

  const outResolved = resolve(out)
  const pendingWrites: { path: string; content: string }[] = []
  for (const [harness, entries] of [...perHarness.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    entries.sort((a, b) => a.signature.localeCompare(b.signature))
    pendingWrites.push({
      path: join(outResolved, harness, 'index.json'),
      content:
        JSON.stringify(
          entries.map((e) => ({ ...e, outcome: null })),
          null,
          2
        ) + '\n'
    })
    for (const e of entries) {
      const key = `${harness}\n${e.signature}`
      const body = [...(fixtureLines.get(key) ?? [])].sort().join('\n') + '\n'
      pendingWrites.push({ path: join(outResolved, harness, e.file), content: body })
    }
  }
  for (const w of pendingWrites) {
    const checked = scrubbedExemptions(w.content)
    for (const [name, re] of LEAK_RULES) {
      if (re.test(checked)) fail(`refusing to write ${w.path}: matches leak rule ${name}`, 1)
    }
  }
  for (const w of pendingWrites) {
    mkdirSync(join(w.path, '..'), { recursive: true })
    writeFileSync(w.path, w.content)
  }

  const pairCount = new Map<Harness, number>()
  for (const p of pairs) pairCount.set(p.harness, (pairCount.get(p.harness) ?? 0) + 1)
  const clusterCount = new Map<Harness, number>()
  for (const [, c] of kept) clusterCount.set(c.harness, (clusterCount.get(c.harness) ?? 0) + 1)
  const lines: string[] = []
  for (const h of [...launched].sort()) {
    lines.push(`MINED ${h} pairs=${pairCount.get(h) ?? 0} clusters=${clusterCount.get(h) ?? 0}`)
  }
  lines.push(`SKIPPED files=${skipped}`)
  process.stdout.write(lines.join('\n') + '\n')
}

main()
