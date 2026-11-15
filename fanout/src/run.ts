import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { adapterFor } from './adapters/index'
import { detectCaller } from './caller'
import { loadCatalog } from './catalog'
import { chunkClass } from './dataclass'
import { appendEvent } from './events'
import { runProcess } from './exec'
import { dataDir } from './paths'
import { candidates, type Candidate } from './pick'
import { renderBlock } from './result'
import { scrubTail } from './scrub'
import { newId } from './ulid'
import { nowIso, nowMs } from './clock'

export interface RunOptions {
  brief: string
  dir: string
  kind: string
  dataClass?: 'public' | 'private'
  timeoutS?: number
}

export async function runChain(o: RunOptions): Promise<{ code: number; block: string }> {
  const briefText = readFileSync(o.brief, 'utf8')
  const briefBytes = Buffer.byteLength(briefText, 'utf8')
  const briefSha = createHash('sha256').update(briefText, 'utf8').digest('hex')
  const { rows, warnings } = loadCatalog()
  for (const w of warnings) console.error(w)
  const dir = o.dir
  const actualClass = o.dataClass ?? chunkClass(dir)
  const upstreamOf = (row: { harness: string; model: string }) => adapterFor(row.harness).upstream?.(row.model)
  const list = candidates(rows, {
    kind: o.kind,
    briefBytes,
    dataClass: actualClass,
    upstreamOf
  })
  if (list.length === 0) {
    console.log('REFUSED no eligible candidate')
    return { code: 3, block: 'REFUSED no eligible candidate' }
  }
  const first: Candidate = list[0]
  const adapter = adapterFor(first.row.harness)
  const preflight = await adapter.preflight({ quick: true })
  if (!preflight.ok) {
    console.log('REFUSED no eligible candidate')
    return { code: 3, block: 'REFUSED no eligible candidate' }
  }
  const job = newId()
  const root = job
  const { caller, session } = detectCaller()
  const repo = repoName(dir)
  const startTs = nowMs()
  appendEvent({
    v: 1,
    ts: nowIso(),
    event: 'job_start',
    id: newId(),
    job,
    root,
    harness: first.row.harness,
    model: first.row.model,
    effort: first.effort,
    tier: first.row.tier,
    kind: o.kind,
    data_class: actualClass,
    attempt: 1,
    reason: 'initial',
    billing: first.row.billing,
    brief_sha: briefSha,
    caller,
    ...(session !== undefined ? { session } : {}),
    repo
  })
  const built = adapter.build({
    model: first.row.model,
    effort: first.effort,
    cwd: dir,
    briefPath: o.brief,
    job,
    outDir: join(dataDir(), 'logs'),
    timeoutS: o.timeoutS ?? 1500,
    maxTurns: 8,
    bypass: false,
    allow: []
  })
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  for (const [k, v] of Object.entries(built.env)) {
    if (v === null) delete env[k]
    else env[k] = v
  }
  const logOut = join(dataDir(), 'logs', `${job}.log`)
  const logErr = join(dataDir(), 'logs', `${job}.err`)
  const out = await runProcess(built.argv, {
    cwd: built.cwd,
    env,
    timeoutS: o.timeoutS ?? 1500,
    logOut,
    logErr
  })
  const usage = adapter.usage(out.stdout)
  const outcome = out.timedOut ? 'timeout' : out.exit === 0 ? 'ok' : 'unknown'
  const endEvent: Record<string, unknown> = {
    v: 1,
    ts: nowIso(),
    event: 'job_end',
    id: newId(),
    job,
    root,
    harness: first.row.harness,
    model: first.row.model,
    outcome,
    exit: out.exit,
    duration_s: Math.round(((nowMs() - startTs) / 1000) * 1000) / 1000,
    cost_source: usage ? 'computed' : 'unknown',
    caller,
    ...(session !== undefined ? { session } : {}),
    repo
  }
  if (usage) {
    endEvent.tokens_in = usage.tokensIn
    endEvent.tokens_out = usage.tokensOut
    endEvent.tokens_cached = usage.tokensCached
  }
  if (outcome !== 'ok') {
    endEvent.stderr_tail = scrubTail(out.stderr + '\n' + out.stdout.slice(-2048), built.secrets, briefText)
  }
  appendEvent(endEvent)
  const rendered = renderBlock({
    job,
    harness: first.row.harness,
    model: first.row.model,
    outcome,
    attempt: 1
  })
  console.log(rendered.block)
  return { code: rendered.code, block: rendered.block }
}

function repoName(dir: string): string {
  try {
    const p = Bun.spawnSync(['git', '-C', dir, 'rev-parse', '--show-toplevel'], {
      stdout: 'pipe',
      stderr: 'ignore'
    })
    if (p.exitCode === 0) {
      const top = p.stdout.toString().trim()
      const base = top.split('/').pop() ?? dir
      if (base) return base
    }
  } catch {
    // fall through
  }
  if (existsSync(dir)) return dir.split('/').filter(Boolean).pop() ?? dir
  return dir
}
