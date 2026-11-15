import { existsSync } from 'node:fs'
import { detectCaller } from '../caller'
import { LEDGER_WINDOW_MS, nowIso, nowMs } from '../clock'
import { registerCommand } from '../cli'
import { appendEvent, ledgerWritable, readEvents, warnUnwritable, type FanoutEvent } from '../events'
import { leasePath } from '../lease'
import { reapStaleLeases } from '../reaper'
import { newId } from '../ulid'

export function findChainRoot(job: string, events?: FanoutEvent[]): string | undefined {
  const list = events ?? readEvents(nowMs() - LEDGER_WINDOW_MS)
  for (const e of list) {
    if (e.event === 'job_start' && e.job === job) return String(e.root ?? e.job)
  }
  for (const e of list) {
    if (e.root === job) return job
  }
  return undefined
}

function usage(): string {
  return 'usage: fanout ack <job>'
}

export async function runAck(rawArgs: string[]): Promise<number> {
  const [job, ...rest] = rawArgs
  if (!job || rest.length > 0) {
    console.error(usage())
    return 2
  }
  const events = readEvents(nowMs() - LEDGER_WINDOW_MS)
  const root = findChainRoot(job, events)
  if (!root) {
    console.error(`unknown job ${job}`)
    return 2
  }
  await reapStaleLeases()
  if (existsSync(leasePath(root))) {
    console.log(`REFUSED chain ${root} is still running; wait with: fanout wait ${root}`)
    return 3
  }
  if (events.some((e) => e.event === 'reported' && e.root === root)) {
    console.log(`ALREADY ${root}`)
    return 0
  }
  const { caller, session } = detectCaller()
  if (!ledgerWritable()) {
    warnUnwritable()
    return 0
  }
  const ok = appendEvent({
    v: 1,
    ts: nowIso(),
    event: 'reported',
    id: newId(),
    job,
    root,
    caller,
    ...(session !== undefined ? { session } : {})
  })
  if (!ok) return 0
  console.log(`ACKED ${root}`)
  return 0
}

registerCommand('ack', runAck)
