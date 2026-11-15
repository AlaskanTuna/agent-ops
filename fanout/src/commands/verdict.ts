import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { detectCaller } from '../caller'
import { LEDGER_WINDOW_MS, nowIso, nowMs } from '../clock'
import { registerCommand } from '../cli'
import { appendEvent, ledgerWritable, readEvents, warnUnwritable } from '../events'
import { dataDir } from '../paths'
import { scrubNote } from '../scrub'
import { newId } from '../ulid'
import { findChainRoot } from './ack'

function usage(): string {
  return 'usage: fanout verdict <job> accepted|rejected [--note <text>]'
}

function appendJudged(line: Record<string, unknown>): void {
  try {
    mkdirSync(join(dataDir(), 'learned'), { recursive: true, mode: 0o700 })
    appendFileSync(join(dataDir(), 'learned', 'state.jsonl'), JSON.stringify(line) + '\n')
  } catch {
    // learned lines never break a verdict
  }
}

export async function runVerdict(rawArgs: string[]): Promise<number> {
  const args = [...rawArgs]
  let job = ''
  let word = ''
  let note: string | undefined
  while (args.length > 0) {
    const a = args.shift()
    if (a === '--note') {
      note = args.shift() ?? ''
    } else if (!job) {
      job = a ?? ''
    } else if (!word) {
      word = a ?? ''
    } else {
      console.error(usage())
      return 2
    }
  }
  if (!job || !word) {
    console.error(usage())
    return 2
  }
  if (word !== 'accepted' && word !== 'rejected') {
    console.error('verdict must be accepted or rejected')
    return 2
  }
  const events = readEvents(nowMs() - LEDGER_WINDOW_MS)
  const root = findChainRoot(job, events)
  if (!root) {
    console.error(`unknown job ${job}`)
    return 2
  }
  const accepted = word === 'accepted'
  const { caller, session } = detectCaller()
  const event: Record<string, unknown> = {
    v: 1,
    ts: nowIso(),
    event: 'verdict',
    id: newId(),
    job,
    root,
    accepted,
    caller,
    ...(session !== undefined ? { session } : {})
  }
  if (note !== undefined) event.note = scrubNote(note)
  if (!ledgerWritable()) {
    warnUnwritable()
    return 0
  }
  if (!appendEvent(event)) return 0
  const start = events.find((e) => e.event === 'job_start' && e.job === job)
  const end = events.find((e) => e.event === 'job_end' && e.job === job)
  const key =
    typeof start?.harness === 'string' && typeof start?.model === 'string'
      ? `${start.harness}/${start.model}`
      : 'unknown/unknown'
  appendJudged({
    ts: nowIso(),
    kind: 'judged',
    key,
    job,
    task_kind: typeof start?.kind === 'string' ? start.kind : 'unknown',
    accepted,
    cost_usd: typeof end?.cost_usd === 'number' ? end.cost_usd : 0
  })
  console.log(`VERDICT ${job} ${word}`)
  return 0
}

registerCommand('verdict', runVerdict)
