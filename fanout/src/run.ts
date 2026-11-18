import type { BuiltCommand } from './adapters/types'
import { SkipCandidate } from './adapters/types'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { adapterFor } from './adapters/index'
import { detectCaller } from './caller'
import { kindInfo, type CatalogRow, loadCatalog } from './catalog'
import { chunkClass, rowClass } from './dataclass'
import { classify, defaultScope } from './classify'
import { billableCost, billableCostAsync, estimate, estimateLine, type Estimate } from './cost'
import { appendEvent, readEvents } from './events'
import { killGroup, readStartTicks, runProcess, workerEnv } from './exec'
import { acquireLease, leasePath } from './lease'
import { reapStaleLeases } from './reaper'
import { dataDir } from './paths'
import { candidates, nextCandidate, nextRung, resolveModel, type PickInput } from './pick'
import { formatLocalHM, renderBlock, type PreFallback, type RenderExtra } from './result'
import {
  appendLearned,
  backoffUntil,
  coolingOf,
  halfOpenTrialKey,
  readLearned,
  readState,
  releaseTrial,
  takeTrial,
  trialStanding,
  waitTarget
} from './state'
import { scrubTail } from './scrub'
import { newId } from './ulid'
import { nowIso, nowMs, sleepClock } from './clock'
import { openWorkspace } from './workspace'

export interface RunOptions {
  brief: string
  dir: string
  kind: string
  dataClass?: 'public' | 'private'
  timeoutS?: number
  startTier?: number
  root?: string
  maxAttempts?: number
  model?: string
  harness?: string
  pin?: boolean
  expect?: string
  escalateFrom?: string
  startEffort?: string
  effort?: string
  noPaid?: boolean
  maxTurns?: number
  allow?: string[]
  bypass?: boolean
  dryRun?: boolean
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

/** Render the live block through the same ledger path a later `wait` would use. */
function liveBlock(
  root: string,
  extra: Omit<RenderExtra, 'live'> | undefined,
  live: NonNullable<RenderExtra['live']>
): string {
  const block = renderBlock(root, { ...extra, live })
  if (block === undefined) throw new Error(`fanout: no ledger events for chain ${root}`)
  return block
}

export async function runDetached(o: RunOptions, passthrough: string[]): Promise<{ code: number; block: string }> {
  const briefText = readFileSync(o.brief, 'utf8')
  const briefBytes = Buffer.byteLength(briefText, 'utf8')
  const { rows, warnings, fatal } = loadCatalog()
  if (fatal) {
    console.log(fatal)
    return { code: 3, block: fatal }
  }
  await reapStaleLeases()
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

/**
 * Promotion on first use: a trial paid row's first real job proves it. An
 * `ok` job promotes the row; `no_effect` or `worker_error` hides it for 7
 * days. Other outcomes leave the row alone for a later attempt.
 */
function recordFirstUse(
  row: CatalogRow,
  outcome: string,
  caller: string,
  session: string | undefined,
  repo: string
): void {
  if (row.status !== 'trial' || row.billing !== 'paid') return
  const key = `${row.harness}/${row.model}`
  if (readLearned().firstUse.has(key)) return
  if (outcome !== 'ok' && outcome !== 'no_effect' && outcome !== 'worker_error') return
  appendLearned('state.jsonl', {
    ts: nowIso(),
    kind: 'first_use',
    key,
    result: outcome === 'ok' ? 'pass' : 'fail',
    caller,
    ...(session !== undefined ? { session } : {}),
    repo
  })
}

export async function runChain(o: RunOptions): Promise<{ code: number; block: string; root: string }> {
  const depthRaw = Number.parseInt(process.env.FANOUT_DEPTH ?? '0', 10)
  const depth = Number.isFinite(depthRaw) ? depthRaw : 0
  if (depth >= 1) {
    const block = `REFUSED nested fanout (FANOUT_DEPTH=${process.env.FANOUT_DEPTH})`
    console.log(block)
    return { code: 3, block, root: o.root ?? '' }
  }
  const briefText = readFileSync(o.brief, 'utf8')
  const briefBytes = Buffer.byteLength(briefText, 'utf8')
  const briefSha = createHash('sha256').update(briefText, 'utf8').digest('hex')
  const { rows, warnings, fatal } = loadCatalog()
  if (fatal) {
    console.log(fatal)
    return { code: 3, block: fatal, root: o.root ?? '' }
  }
  await reapStaleLeases()
  for (const w of warnings) console.error(w)
  const dir = o.dir
  const actualClass = o.dataClass ?? chunkClass(dir)
  const upstreamOf = (row: { harness: string; model: string }) => adapterFor(row.harness).upstream?.(row.model)
  if (o.escalateFrom) {
    const prior = readEvents(nowMs() - 30 * 24 * 3600 * 1000).find(
      (e) => e.event === 'job_start' && e.job === o.escalateFrom
    )
    if (!prior) {
      console.error(`unknown job ${o.escalateFrom}`)
      return { code: 2, block: '', root: o.root ?? '' }
    }
    const rung = nextRung(
      {
        harness: String(prior.harness),
        model: String(prior.model),
        effort: typeof prior.effort === 'string' ? prior.effort : '',
        tier: typeof prior.tier === 'number' ? prior.tier : 1
      },
      rows,
      { kind: o.kind, briefBytes, dataClass: actualClass, noPaid: o.noPaid, upstreamOf }
    )
    if (rung === 'top') {
      console.log('REFUSED already at the top tier')
      return { code: 3, block: 'REFUSED already at the top tier', root: o.root ?? '' }
    }
    if (!rung) {
      console.log('REFUSED no eligible candidate')
      return { code: 3, block: 'REFUSED no eligible candidate', root: o.root ?? '' }
    }
    o.model = `${rung.row.harness}/${rung.row.model}`
    o.startEffort = rung.effort
  }
  let startRow: CatalogRow | undefined = o.model ? resolveModel(rows, o.model, o.harness) : undefined
  if (o.model && !startRow) {
    console.error(`unknown model ${o.model}`)
    return { code: 2, block: '', root: o.root ?? '' }
  }
  if (startRow && actualClass === 'private' && rowClass(startRow, adapterFor(startRow.harness)) === 'public-only') {
    const block = `REFUSED ${startRow.harness}/${startRow.model} is public-only and this chunk is private`
    console.log(block)
    return { code: 3, block, root: o.root ?? '' }
  }
  const pickInput = (): PickInput => ({
    kind: o.kind,
    startTier: o.startTier ?? startRow?.tier,
    harness: o.harness,
    briefBytes,
    dataClass: actualClass,
    noPaid: o.noPaid,
    upstreamOf
  })
  let list = candidates(rows, pickInput())
  let expectedKey = o.expect
  if (o.model && startRow && !o.expect) expectedKey = `${startRow.harness}/${startRow.model}`
  const expectedRow = expectedKey ? resolveModel(rows, expectedKey) : undefined
  if (expectedKey && expectedRow) expectedKey = `${expectedRow.harness}/${expectedRow.model}`
  const inList = (row: CatalogRow): boolean =>
    list.some((c) => c.row.harness === row.harness && c.row.model === row.model)
  let preFallback: PreFallback | undefined
  const pendingSkips: { from: string; reason: string }[] = []
  if (expectedKey) {
    let reason: string | undefined
    if (!expectedRow) reason = 'not in the catalog'
    else if (expectedRow.status === 'retired') reason = 'retired'
    else if (!inList(expectedRow) && expectedRow.status !== 'trial') {
      const cooling = coolingOf(readState(nowMs()), expectedRow)
      reason = cooling ? `cooling down until ${formatLocalHM(cooling.until)}, ${cooling.outcome}` : 'not routable'
    }
    const startKey = startRow ? `${startRow.harness}/${startRow.model}` : undefined
    if (reason && startKey === expectedKey) startRow = undefined
    if (reason && startKey !== expectedKey) {
      const start = startRow && (inList(startRow) || startRow.status === 'trial') ? startRow : list[0]?.row
      if (start) {
        preFallback = {
          expected: expectedKey,
          reason,
          toHarness: start.harness,
          toModel: start.model
        }
      }
    } else if (!reason && expectedRow && startRow && startKey !== expectedKey) {
      if (inList(startRow) || startRow.status === 'trial') {
        preFallback = {
          expected: expectedKey,
          reason: 'overridden by --model',
          toHarness: startRow.harness,
          toModel: startRow.model
        }
      } else {
        startRow = undefined
      }
    } else if (reason && !startRow) {
      const start = list[0]?.row
      if (start) {
        preFallback = {
          expected: expectedKey,
          reason,
          toHarness: start.harness,
          toModel: start.model
        }
      }
    }
  }
  const positioned = startRow
  if (positioned) {
    const idx = list.findIndex((c) => c.row.harness === positioned.harness && c.row.model === positioned.model)
    if (idx >= 0) {
      list = list.slice(idx)
    } else if (positioned.status === 'trial') {
      list = [{ row: positioned, effort: positioned.efforts[0] ?? '' }, ...list]
    } else {
      startRow = undefined
    }
  }
  if (o.startEffort !== undefined && startRow) {
    const i = list.findIndex((c) => c.row.harness === startRow.harness && c.row.model === startRow.model)
    if (i >= 0) list[i] = { ...list[i], effort: o.startEffort }
  }
  if (o.pin && list.length > 1) list = list.slice(0, 1)
  if (list.length === 0) {
    console.log('REFUSED no eligible candidate')
    return { code: 3, block: 'REFUSED no eligible candidate', root: o.root ?? '' }
  }
  if (o.bypass && !inGit(dir)) {
    console.error('--bypass needs a git repository')
    return { code: 2, block: '', root: o.root ?? '' }
  }
  if (o.effort !== undefined) {
    const target = list[0].row
    const key = `${target.harness}/${target.model}`
    if (target.efforts.length === 0) {
      console.error(`${key} takes no effort option`)
      return { code: 2, block: '', root: o.root ?? '' }
    }
    if (!target.efforts.includes(o.effort)) {
      console.error(`effort ${o.effort} is not one of ${target.efforts.join('|')} for ${key}`)
      return { code: 2, block: '', root: o.root ?? '' }
    }
    list[0] = { ...list[0], effort: o.effort }
  }
  const timeoutS = o.timeoutS ?? 1500
  const maxAttempts = o.maxAttempts ?? 8
  const adapterDefaults = adapterFor(list[0].row.harness).defaults
  const maxTurns = o.maxTurns ?? adapterDefaults?.maxTurns ?? 8
  // A default turn cap that a job runs into is raised once, to 3x (at most 500),
  // for the same model. An explicit --max-turns and per-call rows are never raised.
  let turnsNow = maxTurns
  let turnRetried = false
  if (o.dryRun) {
    process.env.FANOUT_DRYRUN = '1'
    const first = list[0]
    const built = adapterFor(first.row.harness).build({
      model: first.row.model,
      effort: first.effort,
      cwd: dir,
      briefPath: o.brief,
      job: newId(),
      outDir: join(dataDir(), 'logs'),
      timeoutS,
      maxTurns,
      bypass: o.bypass ?? false,
      allow: o.allow ?? []
    })
    const redacted = built.argv.map((a) => (built.secrets.includes(a) ? '[secret]' : a))
    const line = `DRYRUN ${first.row.harness}/${first.row.model} effort=${first.effort} cwd=${built.cwd} argv=${JSON.stringify(redacted)}`
    console.log(line)
    return { code: 0, block: line, root: o.root ?? '' }
  }
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
    const deferred = new Set<string>()
    const skippedHarness = new Set<string>()
    const notes: string[] = []
    const attempts: { harness: string; model: string; outcome: string; resetsHHMM?: string }[] = []
    const unknownCounts = new Map<string, number>()
    let pendingReason: string | undefined = o.escalateFrom ? 'escalate' : undefined
    let attempt = 0
    let waited = false
    let prevJob = ''
    let activeTrial: string | undefined
    let trialNoted = false
    let finalJob = o.root ?? ''
    let finalHarness = ''
    let finalModel = ''
    let finalOutcome = 'unknown'
    let finalWorktree: string | undefined
    let finalPatch: string | undefined
    const liveValues = (): NonNullable<RenderExtra['live']> => ({
      job: finalJob,
      harness: finalHarness,
      model: finalModel,
      outcome: finalOutcome,
      attempt,
      ...(finalWorktree ? { worktree: finalWorktree } : {}),
      ...(finalPatch ? { patch: finalPatch } : {})
    })
    let stopNote: string | undefined
    for (;;) {
      const next = nextCandidate(list, tried, skippedHarness, deferred)
      if (!next) {
        const now = nowMs()
        const full = candidates(rows, { ...pickInput(), includeCooling: true }).filter(
          (c) => !skippedHarness.has(c.row.harness)
        )
        const target = waitTarget(
          readState(now),
          full.map((c) => c.row)
        )
        if (target && !waited && !o.pin && target.until - now < 30 * 60 * 1000) {
          const waitS = Math.max(1, Math.round((target.until - now) / 1000))
          console.error(`WAIT ${waitS}s until ${formatLocalHM(target.until)}`)
          await sleepClock(waitS * 1000)
          waited = true
          notes.push(
            `NOTE waited ${waitS}s for ${target.harness}/${target.model} to reset (${formatLocalHM(target.until)})`
          )
          const fresh = readState(nowMs())
          for (const key of [...tried]) {
            const slash = key.indexOf('/')
            if (!coolingOf(fresh, { harness: key.slice(0, slash), model: key.slice(slash + 1) })) tried.delete(key)
          }
          deferred.clear()
          list = candidates(rows, pickInput())
          continue
        }
        const triedText = attempts.map((a) => `${a.harness}/${a.model} (${a.outcome})`).join(', ')
        const block = liveBlock(
          root,
          {
            ...(preFallback ? { preFallback } : {}),
            notes,
            failedText: `FAILED all candidates exhausted. Tried: ${triedText}`
          },
          liveValues()
        )
        console.log(block)
        writeBlock(root, block)
        return { code: 1, block, root }
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
      const gateRowKey = `${next.row.harness}/${next.row.model}`
      const trialKey = halfOpenTrialKey(readState(nowMs()), next.row)
      // An unproven trial row takes at most one concurrent job: claim it
      // atomically, and route elsewhere while another chain holds it.
      const gated = next.row.status === 'trial' && trialStanding(next.row, readLearned(), nowMs()) === 'trial-last'
      const heldKey = trialKey ?? (gated ? gateRowKey : undefined)
      if (heldKey && !takeTrial(heldKey)) {
        deferred.add(gateRowKey)
        continue
      }
      attempt += 1
      const job = attempt === 1 ? root : newId()
      finalJob = job
      finalHarness = next.row.harness
      finalModel = next.row.model
      activeTrial = heldKey
      if (next.row.status === 'trial' && !trialNoted) {
        trialNoted = true
        notes.push(`NOTE model ${next.row.harness}/${next.row.model} has no proof of compatibility yet`)
      }
      if (trialKey) {
        appendEvent({
          v: 1,
          ts: nowIso(),
          event: 'trial',
          id: newId(),
          job,
          root,
          harness: next.row.harness,
          model: next.row.model,
          caller,
          ...(session !== undefined ? { session } : {}),
          repo
        })
      }
      const startTs = nowMs()
      const ws = openWorkspace(dir, root, job, attempt)
      // An adapter can refuse a candidate before anything starts (brief too large for argv, missing key):
      // note it and move on without a job_start, so nothing is spent and nothing is reported as run.
      let built: BuiltCommand
      try {
        built = adapter.build({
          model: next.row.model,
          effort: next.effort,
          cwd: ws.cwd,
          briefPath: o.brief,
          job,
          outDir: join(dataDir(), 'logs'),
          timeoutS,
          maxTurns: turnsNow,
          bypass: o.bypass ?? false,
          allow: o.allow ?? []
        })
      } catch (err) {
        if (!(err instanceof SkipCandidate)) throw err
        const prefix = `${next.row.harness}: `
        const why = err.reason.startsWith(prefix) ? err.reason.slice(prefix.length) : err.reason
        notes.push(`NOTE ${prefix}${why}`)
        tried.add(`${next.row.harness}/${next.row.model}`)
        pendingSkips.push({ from: `${next.row.harness}/${next.row.model}`, reason: why })
        pendingReason = 'fallback'
        if (ws.mode === 'git') ws.finish(job)
        attempt -= 1
        if (activeTrial) {
          releaseTrial(activeTrial)
          activeTrial = undefined
        }
        continue
      }
      for (const sk of pendingSkips.splice(0)) {
        notes.push(
          `FALLBACK ${sk.from} not started (${sk.reason}) -> ${next.row.harness}/${next.row.model}. Tell the user, then run: fanout ack ${root}`
        )
      }
      let est: Estimate | undefined
      const billable = next.row.billing === 'paid' || next.row.billing === 'per_call'
      if (billable) {
        try {
          const e = estimate(next.row, o.kind, { maxTurns })
          if (e && (e.usd !== undefined || e.mc !== undefined)) {
            est = e
            console.error(estimateLine(next.row, e))
          }
        } catch {
          console.error('NOTE cost estimate failed')
        }
      }
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
        max_turns: turnsNow,
        data_class: actualClass,
        workspace: ws.mode === 'git' ? ws.worktree : dir,
        ...(ws.baseSha ? { base_sha: ws.baseSha } : {}),
        attempt,
        reason: pendingReason ?? (attempt === 1 ? (o.escalateFrom ? 'escalate' : 'initial') : 'fallback'),
        ...(attempt === 1 ? (o.escalateFrom ? { from_job: o.escalateFrom } : {}) : { from_job: prevJob }),
        ...(expectedKey ? { expected: expectedKey } : {}),
        billing: next.row.billing,
        ...(est?.usd !== undefined ? { cost_est_usd: est.usd } : {}),
        ...(est?.mc !== undefined ? { cost_est_mc: est.mc, calls_est: est.calls } : {}),
        brief_sha: briefSha,
        caller,
        ...(session !== undefined ? { session } : {}),
        repo
      })
      pendingReason = undefined
      lease.update({ job, harness: next.row.harness, model: next.row.model })
      const env = workerEnv(adapter, built)
      const logOut = join(dataDir(), 'logs', `${job}.log`)
      const logErr = join(dataDir(), 'logs', `${job}.err`)
      const out = await runProcess(built.argv, {
        cwd: built.cwd,
        env,
        timeoutS,
        logOut,
        logErr,
        ...(built.stdinPath !== undefined ? { stdinPath: built.stdinPath } : {}),
        ...(built.stdinText !== undefined ? { stdinText: built.stdinText } : {}),
        onSpawn: (info) => {
          workerPgid = info.pgid
          lease.update({ pgid: info.pgid, workerTicks: readStartTicks(info.pid) })
        }
      })
      const finishAttempt = (o?: { tried?: boolean; release?: boolean }): void => {
        prevJob = job
        if (o?.tried !== false) tried.add(`${next.row.harness}/${next.row.model}`)
        if (o?.release !== false && activeTrial) {
          releaseTrial(activeTrial)
          activeTrial = undefined
        }
        if (ws.mode === 'git') {
          finalWorktree = ws.worktree
          const fin = ws.finish(job)
          if (fin.patch) finalPatch = fin.patch
        }
      }
      const endTs = nowMs()
      if (signal) {
        const detail = `interrupted by ${signal}`
        finalOutcome = 'worker_error'
        attempts.push({ harness: next.row.harness, model: next.row.model, outcome: 'worker_error' })
        let logUsage
        try {
          logUsage = adapter.usage(readFileSync(logOut, 'utf8'))
        } catch {
          logUsage = undefined
        }
        const interruptCost = billableCost(next.row, est, logUsage, 'computed from the worker log')
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
          duration_s: Math.round(((endTs - startTs) / 1000) * 1000) / 1000,
          ...interruptCost.fields,
          caller,
          ...(session !== undefined ? { session } : {}),
          repo
        })
        finishAttempt()
        const block = liveBlock(root, { ...(preFallback ? { preFallback } : {}), notes }, liveValues())
        console.log(block)
        writeBlock(root, block)
        return { code: signal === 'SIGTERM' ? 143 : 130, block, root }
      }
      const usage = adapter.usage(out.stdout)
      const classified = classify(adapter, out, endTs)
      let outcome = classified.outcome
      if (outcome === 'ok' && kindInfo(o.kind).writes) {
        const changed = ws.changedFiles()
        if (Array.isArray(changed) && changed.length === 0) outcome = 'no_effect'
      }
      finalOutcome = outcome
      const normalCost = billable
        ? await billableCostAsync(
            next.row,
            est,
            usage,
            startTs,
            endTs,
            root,
            adapter,
            (h) => adapterFor(h).proxyBacked === true
          )
        : { fields: { cost_source: usage ? 'computed' : 'unknown' } as Record<string, unknown>, line: undefined }
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
        duration_s: Math.round(((endTs - startTs) / 1000) * 1000) / 1000,
        ...normalCost.fields,
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
      const rowKey = `${next.row.harness}/${next.row.model}`
      recordFirstUse(next.row, outcome, caller, session, repo)
      const hitTurnCap =
        outcome === 'job_error' &&
        (/max.?turns/i.test(classified.pattern ?? '') || /error_max_turns/.test(out.stdout.slice(-4096)))
      if (hitTurnCap && o.maxTurns === undefined && !turnRetried && next.row.billing !== 'per_call' && turnsNow < 500) {
        const raised = Math.min(500, turnsNow * 3)
        notes.push(
          `NOTE ${next.row.harness}/${next.row.model} hit its ${turnsNow}-turn limit; retrying once with ${raised} turns`
        )
        turnRetried = true
        turnsNow = raised
        attempts.push({ harness: next.row.harness, model: next.row.model, outcome })
        pendingReason = 'retry'
        finishAttempt({ tried: false, release: false })
        continue
      }
      if (outcome === 'job_error' || outcome === 'no_effect') {
        finishAttempt()
        const failed =
          outcome === 'job_error'
            ? `FAILED job_error: ${classified.match ?? 'job_error'}. The chunk is too large or malformed for this model; split it, or run: fanout run --escalate-from ${finalJob}`
            : `FAILED no_effect: the worker exited 0 but changed no file. Read LOG=${logOut}, then re-brief, or run: fanout run --escalate-from ${finalJob}`
        const block = liveBlock(
          root,
          {
            ...(preFallback ? { preFallback } : {}),
            notes,
            failedText: failed
          },
          liveValues()
        )
        console.log(block)
        writeBlock(root, block)
        return { code: 1, block, root }
      }
      const capStop = (outcome: string): string | undefined => {
        if (!o.pin && attempt < maxAttempts) return undefined
        attempts.push({ harness: next.row.harness, model: next.row.model, outcome })
        finishAttempt()
        const triedText = attempts.map((a) => `${a.harness}/${a.model} (${a.outcome})`).join(', ')
        const block = liveBlock(
          root,
          {
            ...(preFallback ? { preFallback } : {}),
            notes,
            failedText: o.pin
              ? `FAILED all candidates exhausted. Tried: ${triedText}`
              : `FAILED stopped after ${maxAttempts} attempts. Tried: ${triedText}`
          },
          liveValues()
        )
        console.log(block)
        writeBlock(root, block)
        return block
      }
      if (outcome === 'unknown') {
        const seen = (unknownCounts.get(rowKey) ?? 0) + 1
        unknownCounts.set(rowKey, seen)
        if (seen === 1) {
          attempts.push({ harness: next.row.harness, model: next.row.model, outcome })
          pendingReason = 'retry'
          finishAttempt({ tried: false, release: false })
          continue
        }
      }
      if (outcome === 'timeout') {
        const prior = attempts.filter((a) => a.outcome === 'timeout').length
        attempts.push({ harness: next.row.harness, model: next.row.model, outcome })
        finishAttempt()
        if (prior >= 1) {
          const triedText = attempts.map((a) => `${a.harness}/${a.model} (${a.outcome})`).join(', ')
          const note = 'NOTE timed out twice; split the chunk or raise --timeout'
          const block = liveBlock(
            root,
            {
              ...(preFallback ? { preFallback } : {}),
              notes: [...notes, note],
              failedText: `FAILED timed out twice. Tried: ${triedText}`
            },
            liveValues()
          )
          console.log(block)
          writeBlock(root, block)
          return { code: 1, block, root }
        }
        const stopBlock = capStop(outcome)
        if (stopBlock !== undefined) return { code: 1, block: stopBlock, root }
        continue
      }
      let resetMs: number | undefined
      let resetSource: string | undefined
      if (
        outcome === 'rate_limited' ||
        outcome === 'quota_exhausted' ||
        outcome === 'credits_exhausted' ||
        outcome === 'auth_error' ||
        outcome === 'model_unavailable' ||
        outcome === 'worker_error' ||
        outcome === 'unknown'
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
          outcome === 'model_unavailable' ||
          outcome === 'worker_error' ||
          outcome === 'unknown') &&
        ws.mode === 'plain'
      ) {
        const changed = ws.changedFiles()
        if (changed !== 'unknown' && changed.length > 0) {
          stopNote = `NOTE attempt ${attempt} changed files outside git; not retrying`
          attempts.push({ harness: next.row.harness, model: next.row.model, outcome })
          finishAttempt()
          const block = liveBlock(
            root,
            {
              ...(preFallback ? { preFallback } : {}),
              notes: [...notes, stopNote],
              failedText: ''
            },
            liveValues()
          )
          console.log(block)
          writeBlock(root, block)
          return { code: 1, block, root }
        }
      }
      if (
        outcome === 'rate_limited' ||
        outcome === 'quota_exhausted' ||
        outcome === 'credits_exhausted' ||
        outcome === 'auth_error' ||
        outcome === 'model_unavailable' ||
        outcome === 'worker_error' ||
        outcome === 'unknown'
      ) {
        attempts.push({
          harness: next.row.harness,
          model: next.row.model,
          outcome,
          ...(resetMs !== undefined ? { resetsHHMM: formatLocalHM(resetMs) } : {})
        })
        finishAttempt()
        void stopNote
        const stopBlock = capStop(outcome)
        if (stopBlock !== undefined) return { code: 1, block: stopBlock, root }
        continue
      }
      attempts.push({ harness: next.row.harness, model: next.row.model, outcome })
      finishAttempt()
      const block = liveBlock(root, { ...(preFallback ? { preFallback } : {}), notes }, liveValues())
      console.log(block)
      writeBlock(root, block)
      return { code: outcome === 'ok' ? 0 : 1, block, root }
    }
  } finally {
    process.removeListener('SIGTERM', onTerm)
    process.removeListener('SIGINT', onInt)
    lease.release()
  }
}

function inGit(dir: string): boolean {
  try {
    const p = Bun.spawnSync(['git', '-C', dir, 'rev-parse', '--show-toplevel'], {
      stdout: 'ignore',
      stderr: 'ignore'
    })
    return p.exitCode === 0
  } catch {
    return false
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
