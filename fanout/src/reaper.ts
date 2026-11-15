import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { adapterFor } from './adapters'
import { billableCostAsync, type Estimate } from './cost'
import { loadCatalog } from './catalog'
import { LEDGER_WINDOW_MS, nowIso, nowMs } from './clock'
import { appendEvent, readEvents } from './events'
import { killGroup, readStartTicks } from './exec'
import { type LeaseData } from './lease'
import { dataDir, runDir } from './paths'
import { renderBlock } from './result'
import { notifyOnce } from './notify'
import { newId } from './ulid'

export interface ReapedChain {
  root: string
  job: string
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but belongs to another user: treat as alive.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

function isStale(data: LeaseData): boolean {
  if (!pidAlive(data.pid)) return true
  if (data.startTicks > 0) return readStartTicks(data.pid) !== data.startTicks
  return false
}

/** Close the chain's open job as an orphaned worker_error with cost from the worker log. */
async function closeOrphan(root: string): Promise<string | undefined> {
  const now = nowMs()
  const events = readEvents(now - LEDGER_WINDOW_MS)
  const starts = events
    .filter((e) => e.event === 'job_start' && String(e.root ?? e.job) === root)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || String(a.id).localeCompare(String(b.id)))
  if (starts.length === 0) return undefined
  const last = starts[starts.length - 1]
  const lastJob = String(last.job)
  if (events.some((e) => e.event === 'job_end' && e.job === lastJob)) return undefined
  const harness = String(last.harness)
  const model = String(last.model)
  const adapter = adapterFor(harness)
  let usage
  try {
    usage = adapter.usage(readFileSync(join(dataDir(), 'logs', `${lastJob}.log`), 'utf8'))
  } catch {
    usage = undefined
  }
  const startMs = Date.parse(String(last.ts))
  const row = loadCatalog().rows.find((r) => r.harness === harness && r.model === model)
  let fields: Record<string, unknown> = { cost_source: 'unknown' }
  if (row && Number.isFinite(startMs)) {
    const est: Estimate | undefined =
      typeof last.cost_est_usd === 'number'
        ? { usd: last.cost_est_usd, basis: 'prior', samples: 0 }
        : typeof last.cost_est_mc === 'number'
          ? {
              mc: last.cost_est_mc,
              calls: typeof last.calls_est === 'number' ? last.calls_est : 8,
              basis: 'per_call',
              samples: 0
            }
          : undefined
    const cost = await billableCostAsync(
      row,
      est,
      usage,
      startMs,
      now,
      root,
      adapter,
      (h) => adapterFor(h).proxyBacked === true
    )
    fields = cost.fields
  }
  const endEvent: Record<string, unknown> = {
    v: 1,
    ts: nowIso(),
    event: 'job_end',
    id: newId(),
    job: lastJob,
    root,
    harness,
    model,
    outcome: 'worker_error',
    detail: 'orphaned lease',
    exit: null,
    duration_s: Math.round(((now - (Number.isFinite(startMs) ? startMs : now)) / 1000) * 1000) / 1000,
    ...fields,
    caller: typeof last.caller === 'string' ? last.caller : 'unknown',
    ...(typeof last.session === 'string' ? { session: last.session } : {}),
    repo: typeof last.repo === 'string' ? last.repo : harness
  }
  if (usage) {
    endEvent.tokens_in = usage.tokensIn
    endEvent.tokens_out = usage.tokensOut
    endEvent.tokens_cached = usage.tokensCached
  }
  appendEvent(endEvent)
  // A paid orphan's actual was computed from the worker log, not live tokens.
  const block = renderBlock(root)
  if (block !== undefined) {
    try {
      mkdirSync(join(dataDir(), 'logs'), { recursive: true, mode: 0o700 })
      writeFileSync(join(dataDir(), 'logs', `${root}.block`), block, { mode: 0o600 })
    } catch {
      // block persistence never breaks a reap
    }
    await notifyOnce(root, block)
  }
  return lastJob
}

/**
 * Reap stale chain leases: kill the orphaned worker group (only when the
 * recorded worker start ticks still match, so a reused pid is never
 * signalled), close the chain's open job as `worker_error` with its cost,
 * and rewrite the result block. Idempotent: with no stale lease there is
 * nothing to do.
 */
export async function reapStaleLeases(): Promise<ReapedChain[]> {
  const out: ReapedChain[] = []
  let files: string[] = []
  try {
    files = readdirSync(runDir())
  } catch {
    return out
  }
  for (const f of files.sort()) {
    if (!f.endsWith('.lease')) continue
    const root = f.slice(0, -'.lease'.length)
    let data: LeaseData
    try {
      data = JSON.parse(readFileSync(join(runDir(), f), 'utf8')) as LeaseData
    } catch {
      continue
    }
    if (!isStale(data)) continue
    if (data.pgid > 0 && data.workerTicks > 0) {
      try {
        if (readStartTicks(data.pgid) === data.workerTicks) {
          killGroup(data.pgid, 'SIGTERM')
          const deadline = Date.now() + 2000
          while (Date.now() < deadline && readStartTicks(data.pgid) === data.workerTicks) {
            try {
              Bun.sleepSync(50)
            } catch {
              break
            }
          }
          if (readStartTicks(data.pgid) === data.workerTicks) killGroup(data.pgid, 'SIGKILL')
        }
      } catch {
        // the guarded kill never breaks a reap
      }
    }
    const job = await closeOrphan(root)
    try {
      unlinkSync(join(runDir(), f))
    } catch {
      // lease removal never breaks a reap
    }
    if (job) out.push({ root, job })
  }
  return out
}
