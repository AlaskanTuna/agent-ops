import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadCatalog, type CatalogRow } from '../catalog'
import { LEDGER_WINDOW_MS, nowIso, nowMs } from '../clock'
import { appendEvent, readEvents, type FanoutEvent } from '../events'
import { newId } from '../ulid'
import { dataDir } from '../paths'
import { registerStep, type StepCtx } from './index'
import { appendLearned, paidTrialKeys, readLearned, smokeSummary, SMOKE_RETRY_MS } from '../state'

export const SMOKE_TEXT = 'fanout-smoke-ok\n'
export const SMOKE_BRIEF =
  'Create a file named smoke.txt in the current directory containing exactly the text fanout-smoke-ok followed by one newline, and nothing else. Do not create any other file. Do not run git.'

export interface SmokeResult {
  result: 'pass' | 'fail' | 'skipped'
  detail: string
}

const LIMIT_OUTCOMES = new Set(['rate_limited', 'quota_exhausted', 'credits_exhausted', 'auth_error', 'timeout'])
// model_unavailable is not a limit: the job reached the provider and the
// model could not serve it, so the smoke fails and waits 7 days.

function smokeOutcomeToResult(outcome: string | undefined): 'pass-check' | 'skipped' | 'fail' {
  if (outcome === 'ok') return 'pass-check'
  if (outcome !== undefined && LIMIT_OUTCOMES.has(outcome)) return 'skipped'
  return 'fail'
}

function checkSmokeDir(dir: string): { ok: boolean; detail: string } {
  let entries: string[] = []
  try {
    entries = readdirSync(dir).sort()
  } catch (err) {
    return { ok: false, detail: `cannot read smoke directory: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!entries.includes('smoke.txt')) return { ok: false, detail: 'smoke.txt missing' }
  const extra = entries.filter((e) => e !== 'smoke.txt')
  if (extra.length > 0) return { ok: false, detail: `unexpected files: ${extra.join(', ')}` }
  let bytes = ''
  try {
    bytes = readFileSync(join(dir, 'smoke.txt'), 'utf8')
  } catch (err) {
    return { ok: false, detail: `cannot read smoke.txt: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (bytes !== SMOKE_TEXT) return { ok: false, detail: 'smoke.txt has wrong bytes' }
  return { ok: true, detail: 'bytes match' }
}

function lastChainEnd(root: string): { job: string; end: FanoutEvent | undefined } {
  const events = readEvents(nowMs() - LEDGER_WINDOW_MS)
  const starts = events
    .filter((e) => e.event === 'job_start' && String(e.root ?? e.job) === root)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || String(a.id).localeCompare(String(b.id)))
  const last = starts[starts.length - 1]
  if (!last) return { job: '', end: undefined }
  return { job: String(last.job), end: events.find((e) => e.event === 'job_end' && e.job === last.job) }
}

async function smokeOne(ctx: StepCtx, row: CatalogRow): Promise<SmokeResult> {
  mkdirSync(join(dataDir(), 'smoke'), { recursive: true, mode: 0o700 })
  const dir = mkdtempSync(join(dataDir(), 'smoke', 'smoke-'))
  const briefPath = join(dataDir(), 'smoke', `${dir.split('/').pop()}.brief`)
  writeFileSync(briefPath, SMOKE_BRIEF, { mode: 0o600 })
  const args = [
    '--brief',
    briefPath,
    '--dir',
    dir,
    '--kind',
    'smoke',
    '--public',
    '--pin',
    '--model',
    `${row.harness}/${row.model}`
  ]
  const effort = row.efforts[0] ?? ''
  if (effort !== '') args.push('--effort', effort)
  if (row.billing === 'per_call') args.push('--max-turns', '2')
  const { code, block, root } = await ctx.run(args)
  void code
  void block
  const { job, end } = lastChainEnd(root)
  const outcome = typeof end?.outcome === 'string' ? end.outcome : undefined
  const mapped = smokeOutcomeToResult(outcome)
  let result: SmokeResult
  if (mapped === 'skipped') {
    result = { result: 'skipped', detail: outcome === undefined ? 'not started' : `outcome ${outcome}` }
  } else if (mapped === 'fail') {
    result = { result: 'fail', detail: outcome === undefined ? 'no job ran' : `outcome ${outcome ?? 'unknown'}` }
  } else {
    const checked = checkSmokeDir(dir)
    if (!checked.ok) {
      result = { result: 'fail', detail: checked.detail }
    } else if (row.billing === 'per_call') {
      const calls = typeof end?.calls === 'number' ? end.calls : undefined
      result =
        calls === undefined
          ? { result: 'pass', detail: 'smoke.txt has the exact bytes, calls unmeasured' }
          : calls > 2
            ? { result: 'pass', detail: `smoke.txt has the exact bytes, ${calls} calls measured (over budget)` }
            : { result: 'pass', detail: `smoke.txt has the exact bytes, ${calls} calls measured` }
    } else {
      result = { result: 'pass', detail: 'smoke.txt has the exact bytes' }
    }
  }
  appendEvent({
    v: 1,
    ts: nowIso(),
    event: 'smoke',
    id: newId(),
    job,
    root,
    harness: row.harness,
    model: row.model,
    result: result.result,
    detail: result.detail,
    caller: 'upkeep'
  })
  if (result.result !== 'skipped') {
    appendLearned('state.jsonl', {
      ts: nowIso(),
      kind: 'smoke',
      key: `${row.harness}/${row.model}`,
      result: result.result,
      detail: result.detail
    })
  }
  return result
}

export async function runSmoke(ctx: StepCtx): Promise<string> {
  const { rows } = loadCatalog()
  const learned = readLearned()
  const now = nowMs()
  const byTier = (a: CatalogRow, b: CatalogRow): number =>
    a.tier !== b.tier ? a.tier - b.tier : `${a.harness}/${a.model}` < `${b.harness}/${b.model}` ? -1 : 1
  const unproven = (billing: 'free' | 'subscription' | 'per_call'): CatalogRow[] =>
    rows
      .filter(
        (r) =>
          r.status === 'trial' &&
          r.billing === billing &&
          !learned.gone.has(`${r.harness}/${r.model}`) &&
          learned.firstUse.get(`${r.harness}/${r.model}`)?.result !== 'pass' &&
          (learned.judged.get(`${r.harness}/${r.model}`)?.accepted ?? 0) < 5 &&
          learned.smoke.get(`${r.harness}/${r.model}`)?.result !== 'pass' &&
          !(
            learned.smoke.get(`${r.harness}/${r.model}`)?.result === 'fail' &&
            now - (learned.smoke.get(`${r.harness}/${r.model}`)?.ts ?? 0) < SMOKE_RETRY_MS
          )
      )
      .sort(byTier)
  const free = unproven('free').concat(unproven('subscription')).sort(byTier).slice(0, 5)
  const perCall = unproven('per_call').slice(0, 3)
  let ok = 0
  let skipped = 0
  let failed = 0
  for (const row of [...free, ...perCall]) {
    const r = await smokeOne(ctx, row)
    if (r.result === 'pass') ok += 1
    else if (r.result === 'skipped') skipped += 1
    else failed += 1
  }
  const paid = paidTrialKeys(rows, readLearned())
  const summary = smokeSummary(rows, readLearned(), nowMs())
  ctx.updateStatus({ smoke: summary, paid_trial: paid })
  const trialCount = free.length + perCall.length
  return `smoked ${trialCount} (${ok} pass, ${failed} fail, ${skipped} skipped), ${paid.length} paid rows promote on first use`
}

export function registerSmokeStep(): void {
  registerStep('smoke', runSmoke)
}
