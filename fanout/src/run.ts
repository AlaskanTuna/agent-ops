import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { adapterFor } from './adapters/index'
import { detectCaller } from './caller'
import { loadCatalog } from './catalog'
import { chunkClass } from './dataclass'
import { classify, defaultScope } from './classify'
import { appendEvent, readEvents } from './events'
import { killGroup, readStartTicks, runProcess, workerEnv } from './exec'
import { acquireLease, leasePath } from './lease'
import { dataDir } from './paths'
import { candidates, nextCandidate } from './pick'
import { formatLocalHM, renderBlock, type Hop } from './result'
import { backoffUntil } from './state'
import { scrubTail } from './scrub'
import { newId } from './ulid'
import { nowIso, nowMs } from './clock'
import { openWorkspace } from './workspace'

export interface RunOptions {
  brief: string
  dir: string
  kind: string
  dataClass?: 'public' | 'private'
  timeoutS?: number
  startTier?: number
  root?: string
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function findChain(job: string): { root: string; state: 'running' | 'finished' } | undefined {
  if (existsSync(leasePath(job))) return { root: job, state: 'running' }
  const events = readEvents(Date.now() - 30 * 24 * 3600 * 1000)
  let root: string | undefined
  for (const e of events) {
    if (e.event === 'job_start' && e.job === job) root = String(e.root ?? e.job)
    else if (e.root === job) root = job
  }
  if (!root) return undefined
  return existsSync(leasePath(root)) ? { root, state: 'running' } : { root, state: 'finished' }
}

export function chainExitCode(root: string): number {
  const events = readEvents(Date.now() - 30 * 24 * 3600 * 1000)
  let outcome: unknown
  for (const e of events) {
    if (e.root === root && e.event === 'job_end') outcome = e.outcome
  }
  return outcome === 'ok' ? 0 : 1
}

function writeBlock(root: string, block: string): void {
  try {
    mkdirSync(join(dataDir(), 'logs'), { recursive: true, mode: 0o700 })
    writeFileSync(join(dataDir(), 'logs', `${root}.block`), block, { mode: 0o600 })
  } catch {
    // block persistence never breaks a run
  }
}

export async function runDetached(o: RunOptions, passthrough: string[]): Promise<{ code: number; block: string }> {
  const briefText = readFileSync(o.brief, 'utf8')
  const briefBytes = Buffer.byteLength(briefText, 'utf8')
  const { rows, warnings } = loadCatalog()
  for (const w of warnings) console.error(w)
  const actualClass = o.dataClass ?? chunkClass(o.dir)
  const upstreamOf = (row: { harness: string; model: string }) => adapterFor(row.harness).upstream?.(row.model)
  const list = candidates(rows, {
    kind: o.kind,
    startTier: o.startTier,
    briefBytes,
    dataClass: actualClass,
    upstreamOf
  })
  if (list.length === 0) {
    console.log('REFUSED no eligible candidate')
    return { code: 3, block: 'REFUSED no eligible candidate' }
  }
  const root = newId()
  mkdirSync(join(dataDir(), 'logs'), { recursive: true, mode: 0o700 })
  const chainLog = join(dataDir(), 'logs', `${root}.chain`)
  let fd = -1
  try {
    fd = openSync(chainLog, 'a', 0o600)
  } catch {
    // log failures never break a run
  }
  const script = process.argv[1] ?? ''
  const child = spawn(process.execPath, [script, 'run', ...passthrough, '--root', root], {
    cwd: process.cwd(),
    env: { ...process.env },
    detached: true,
    stdio: ['ignore', fd >= 0 ? fd : 'ignore', fd >= 0 ? fd : 'ignore']
  })
  child.unref()
  const start = Date.now()
  let seen = false
  while (Date.now() - start < 5000) {
    if (existsSync(leasePath(root))) {
      seen = true
      break
    }
    await sleepMs(50)
  }
  if (!seen) {
    const block = `FAILED detach: the chain did not start (see logs/${root}.chain)`
    console.log(block)
    return { code: 1, block }
  }
  console.log(`JOB ${root}`)
  console.log(`WAIT run: fanout wait ${root}`)
  return { code: 0, block: `JOB ${root}` }
}

export async function runChain(o: RunOptions): Promise<{ code: number; block: string }> {
  const depthRaw = Number.parseInt(process.env.FANOUT_DEPTH ?? '0', 10)
  const depth = Number.isFinite(depthRaw) ? depthRaw : 0
  if (depth >= 1) {
    const block = `REFUSED nested fanout (FANOUT_DEPTH=${process.env.FANOUT_DEPTH})`
    console.log(block)
    return { code: 3, block }
  }
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
    startTier: o.startTier,
    briefBytes,
    dataClass: actualClass,
    upstreamOf
  })
  if (list.length === 0) {
    console.log('REFUSED no eligible candidate')
    return { code: 3, block: 'REFUSED no eligible candidate' }
  }
  const timeoutS = o.timeoutS ?? 1500
  const job = o.root ?? newId()
  const root = o.root ?? job
  const lease = acquireLease(root)
  let workerPgid = 0
  let signal: 'SIGTERM' | 'SIGINT' | undefined
  const killWorker = () => {
    if (workerPgid) {
      killGroup(workerPgid, 'SIGTERM')
      const t = setTimeout(() => killGroup(workerPgid, 'SIGKILL'), 2000)
      if (t.unref) t.unref()
    }
  }
  const onTerm = () => {
    signal = 'SIGTERM'
    killWorker()
  }
  const onInt = () => {
    signal = 'SIGINT'
    killWorker()
  }
  process.once('SIGTERM', onTerm)
  process.once('SIGINT', onInt)
  try {
    const { caller, session } = detectCaller()
    const repo = repoName(dir)
    const tried = new Set<string>()
    const skippedHarness = new Set<string>()
    const notes: string[] = []
    const attempts: { harness: string; model: string; outcome: string; resetsHHMM?: string }[] = []
    let attempt = 0
    let prevJob = ''
    let finalJob = o.root ?? ''
    let finalHarness = ''
    let finalModel = ''
    let finalOutcome = 'unknown'
    let finalWorktree: string | undefined
    let finalPatch: string | undefined
    let stopNote: string | undefined
    for (;;) {
      const next = nextCandidate(list, tried, skippedHarness)
      if (!next) {
        const triedText = attempts.map((a) => `${a.harness}/${a.model} (${a.outcome})`).join(', ')
        const rendered = renderBlock({
          job: finalJob,
          harness: finalHarness,
          model: finalModel,
          outcome: finalOutcome,
          attempt,
          ...(finalWorktree ? { worktree: finalWorktree } : {}),
          ...(finalPatch ? { patch: finalPatch } : {}),
          notes,
          failed: `FAILED all candidates exhausted. Tried: ${triedText}`
        })
        console.log(rendered.block)
        writeBlock(root, rendered.block)
        return { code: 1, block: rendered.block }
      }
      const adapter = adapterFor(next.row.harness)
      const preflight = await adapter.preflight({ quick: true })
      if (!preflight.ok) {
        skippedHarness.add(next.row.harness)
        notes.push(`NOTE ${next.row.harness}: ${preflight.detail}`)
        appendEvent({
          v: 1,
          ts: nowIso(),
          event: 'limit_hit',
          id: newId(),
          job: root,
          root,
          harness: next.row.harness,
          model: '*',
          scope: 'account',
          outcome: 'worker_error',
          source: 'backoff',
          until: new Date(nowMs() + 15 * 60 * 1000).toISOString(),
          caller,
          ...(session !== undefined ? { session } : {}),
          repo
        })
        continue
      }
      attempt += 1
      const job = attempt === 1 ? root : newId()
      finalJob = job
      finalHarness = next.row.harness
      finalModel = next.row.model
      const startTs = nowMs()
      const ws = openWorkspace(dir, root, job, attempt)
      appendEvent({
        v: 1,
        ts: nowIso(),
        event: 'job_start',
        id: newId(),
        job,
        root,
        harness: next.row.harness,
        model: next.row.model,
        effort: next.effort,
        tier: next.row.tier,
        kind: o.kind,
        data_class: actualClass,
        workspace: ws.mode === 'git' ? ws.worktree : dir,
        ...(ws.baseSha ? { base_sha: ws.baseSha } : {}),
        attempt,
        reason: attempt === 1 ? 'initial' : 'fallback',
        ...(attempt === 1 ? {} : { from_job: prevJob }),
        billing: next.row.billing,
        brief_sha: briefSha,
        caller,
        ...(session !== undefined ? { session } : {}),
        repo
      })
      lease.update({ job, harness: next.row.harness, model: next.row.model })
      const built = adapter.build({
        model: next.row.model,
        effort: next.effort,
        cwd: ws.cwd,
        briefPath: o.brief,
        job,
        outDir: join(dataDir(), 'logs'),
        timeoutS,
        maxTurns: 8,
        bypass: false,
        allow: []
      })
      const env = workerEnv(adapter, built)
      const logOut = join(dataDir(), 'logs', `${job}.log`)
      const logErr = join(dataDir(), 'logs', `${job}.err`)
      const out = await runProcess(built.argv, {
        cwd: built.cwd,
        env,
        timeoutS,
        logOut,
        logErr,
        onSpawn: (info) => {
          workerPgid = info.pgid
          lease.update({ pgid: info.pgid, workerTicks: readStartTicks(info.pid) })
        }
      })
      const finishAttempt = (): void => {
        prevJob = job
        tried.add(`${next.row.harness}/${next.row.model}`)
        if (ws.mode === 'git') {
          finalWorktree = ws.worktree
          const fin = ws.finish(job)
          if (fin.patch) finalPatch = fin.patch
        }
      }
      if (signal) {
        const detail = `interrupted by ${signal}`
        finalOutcome = 'worker_error'
        attempts.push({ harness: next.row.harness, model: next.row.model, outcome: 'worker_error' })
        appendEvent({
          v: 1,
          ts: nowIso(),
          event: 'job_end',
          id: newId(),
          job,
          root,
          harness: next.row.harness,
          model: next.row.model,
          outcome: 'worker_error',
          detail,
          exit: out.exit,
          duration_s: Math.round(((nowMs() - startTs) / 1000) * 1000) / 1000,
          cost_source: 'unknown',
          caller,
          ...(session !== undefined ? { session } : {}),
          repo
        })
        finishAttempt()
        const rendered = renderBlock({
          job: finalJob,
          harness: finalHarness,
          model: finalModel,
          outcome: 'worker_error',
          attempt,
          ...(finalWorktree ? { worktree: finalWorktree } : {}),
          ...(finalPatch ? { patch: finalPatch } : {}),
          notes
        })
        console.log(rendered.block)
        writeBlock(root, rendered.block)
        return { code: signal === 'SIGTERM' ? 143 : 130, block: rendered.block }
      }
      const usage = adapter.usage(out.stdout)
      const classified = classify(adapter, out, nowMs())
      const outcome = classified.outcome
      finalOutcome = outcome
      const endEvent: Record<string, unknown> = {
        v: 1,
        ts: nowIso(),
        event: 'job_end',
        id: newId(),
        job,
        root,
        harness: next.row.harness,
        model: next.row.model,
        outcome,
        exit: out.exit,
        duration_s: Math.round(((nowMs() - startTs) / 1000) * 1000) / 1000,
        cost_source: usage ? 'computed' : 'unknown',
        caller,
        ...(session !== undefined ? { session } : {}),
        repo
      }
      if (classified.pattern) endEvent.pattern = classified.pattern
      if (usage) {
        endEvent.tokens_in = usage.tokensIn
        endEvent.tokens_out = usage.tokensOut
        endEvent.tokens_cached = usage.tokensCached
      }
      if (outcome !== 'ok') {
        endEvent.stderr_tail = scrubTail(out.stderr + '\n' + out.stdout.slice(-2048), built.secrets, briefText)
      }
      appendEvent(endEvent)
      let resetMs: number | undefined
      let resetSource: string | undefined
      if (
        outcome === 'rate_limited' ||
        outcome === 'quota_exhausted' ||
        outcome === 'credits_exhausted' ||
        outcome === 'auth_error' ||
        outcome === 'model_unavailable'
      ) {
        const scope = classified.scope ?? defaultScope(outcome)
        const at =
          classified.until ??
          (classified.cooldownS !== undefined
            ? startTs + classified.cooldownS * 1000
            : backoffUntil(next.row.harness, next.row.model, scope, startTs))
        resetSource = classified.until !== undefined ? 'stated' : 'backoff'
        if (resetSource === 'stated') resetMs = at
        appendEvent({
          v: 1,
          ts: nowIso(),
          event: 'limit_hit',
          id: newId(),
          job,
          root,
          harness: next.row.harness,
          model: next.row.model,
          scope,
          outcome,
          source: resetSource,
          until: new Date(at).toISOString(),
          caller,
          ...(session !== undefined ? { session } : {}),
          repo
        })
      }
      if (
        (outcome === 'rate_limited' ||
          outcome === 'quota_exhausted' ||
          outcome === 'credits_exhausted' ||
          outcome === 'auth_error' ||
          outcome === 'model_unavailable') &&
        ws.mode === 'plain'
      ) {
        const changed = ws.changedFiles()
        if (changed !== 'unknown' && changed.length > 0) {
          stopNote = `NOTE attempt ${attempt} changed files outside git; not retrying`
          attempts.push({ harness: next.row.harness, model: next.row.model, outcome })
          finishAttempt()
          const rendered = renderBlock({
            job: finalJob,
            harness: finalHarness,
            model: finalModel,
            outcome,
            attempt,
            notes: [...notes, stopNote]
          })
          console.log(rendered.block)
          writeBlock(root, rendered.block)
          return { code: 1, block: rendered.block }
        }
      }
      if (
        outcome === 'rate_limited' ||
        outcome === 'quota_exhausted' ||
        outcome === 'credits_exhausted' ||
        outcome === 'auth_error' ||
        outcome === 'model_unavailable'
      ) {
        attempts.push({
          harness: next.row.harness,
          model: next.row.model,
          outcome,
          ...(resetMs !== undefined ? { resetsHHMM: formatLocalHM(resetMs) } : {})
        })
        finishAttempt()
        void stopNote
        continue
      }
      attempts.push({ harness: next.row.harness, model: next.row.model, outcome })
      finishAttempt()
      const fallbacks: Hop[] = []
      for (let i = 0; i + 1 < attempts.length; i++) {
        fallbacks.push({
          fromHarness: attempts[i].harness,
          fromModel: attempts[i].model,
          outcome: attempts[i].outcome,
          ...(attempts[i].resetsHHMM ? { resetsHHMM: attempts[i].resetsHHMM } : {}),
          toHarness: attempts[i + 1].harness,
          toModel: attempts[i + 1].model
        })
      }
      const rendered = renderBlock({
        job: finalJob,
        harness: finalHarness,
        model: finalModel,
        outcome,
        attempt,
        ...(finalWorktree ? { worktree: finalWorktree } : {}),
        ...(finalPatch ? { patch: finalPatch } : {}),
        fallbacks,
        notes
      })
      console.log(rendered.block)
      writeBlock(root, rendered.block)
      return { code: rendered.code, block: rendered.block }
    }
  } finally {
    process.removeListener('SIGTERM', onTerm)
    process.removeListener('SIGINT', onInt)
    lease.release()
  }
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
