import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectCaller } from '../caller'
import { nowIso, nowMs } from '../clock'
import { appendEvent } from '../events'
import { dataDir } from '../paths'
import { newId } from '../ulid'
import { acquireUpkeepLock, releaseUpkeepLock } from './lock'

export interface StepCtx {
  run: (args: string[]) => Promise<{ code: number; block: string; root: string }>
  updateStatus: (patch: Record<string, unknown>) => void
}

export type StepFn = (ctx: StepCtx) => Promise<string | void>

/** Throw to record the step as skipped instead of ok or failed. Skips never count as failures. */
export class StepSkipped extends Error {}

export interface StepDef {
  name: string
  fn: StepFn
}

const steps: StepDef[] = []

export function registerStep(name: string, fn: StepFn): void {
  steps.push({ name, fn })
}

function statusPath(): string {
  return join(dataDir(), 'status.json')
}

export function readStatusJson(): Record<string, unknown> | undefined {
  try {
    if (!existsSync(statusPath())) return undefined
    const parsed = JSON.parse(readFileSync(statusPath(), 'utf8')) as Record<string, unknown>
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

export function writeStatusJson(doc: Record<string, unknown>): void {
  try {
    const tmp = `${statusPath()}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, statusPath())
  } catch {
    // status.json never breaks upkeep
  }
}

const STEP_LIMIT_MS = 10 * 60 * 1000

function withLimit(fn: StepFn, ctx: StepCtx): Promise<string | void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('step timed out after 10 minutes')), STEP_LIMIT_MS)
    if (timer.unref) timer.unref()
  })
  return Promise.race([fn(ctx), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

export function defaultStatusJson(): Record<string, unknown> {
  return {
    generated_at: nowIso(),
    last_upkeep_attempt: nowIso(),
    last_upkeep_ok: nowIso(),
    benchmarks_refreshed_at: null,
    benchmarks_note: null,
    new_models: [],
    gone_models: [],
    smoke: { pass: 0, fail: 0, pending: 0 },
    paid_trial: []
  }
}

export async function runUpkeepSteps(names: string[], ctx: StepCtx): Promise<{ failed: number }> {
  const selected = names.length > 0 ? steps.filter((s) => names.includes(s.name)) : [...steps]
  const { caller, session } = detectCaller()
  const ends: number[] = []
  let failed = 0
  for (const step of selected) {
    let status = 'ok'
    let detail = ''
    try {
      const out = await withLimit(step.fn, ctx)
      if (typeof out === 'string' && out !== '') detail = out
    } catch (err) {
      if (err instanceof StepSkipped) {
        status = 'skipped'
        detail = err.message
      } else {
        status = 'failed'
        failed += 1
        detail = err instanceof Error ? err.message : String(err)
      }
    }
    ends.push(nowMs())
    appendEvent({
      v: 1,
      ts: nowIso(),
      event: 'upkeep',
      id: newId(),
      step: step.name,
      status,
      detail,
      caller,
      ...(session !== undefined ? { session } : {})
    })
  }
  const doc: Record<string, unknown> = { ...defaultStatusJson(), ...readStatusJson() }
  doc.last_upkeep_attempt = nowIso()
  if (failed === 0) doc.last_upkeep_ok = nowIso()
  // generated_at lands after every step event, even with a frozen clock.
  doc.generated_at = new Date(Math.max(nowMs(), ...ends) + 1).toISOString()
  writeStatusJson(doc)
  return { failed }
}

export async function withUpkeepLock<T>(work: () => Promise<T>): Promise<{ ran: boolean; value?: T }> {
  if (!acquireUpkeepLock()) return { ran: false }
  try {
    return { ran: true, value: await work() }
  } finally {
    releaseUpkeepLock()
  }
}
