import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { detectCaller } from '../caller'
import { nowIso } from '../clock'
import { registerCommand } from '../cli'
import { appendEvent, ledgerWritable, readEvents, warnUnwritable, type FanoutEvent } from '../events'
import { dataDir } from '../paths'
import { scrubText } from '../scrub'
import { newId } from '../ulid'
import { VERSION } from '../version'
import { findChainRoot } from './ack'

// Incident reports: an agent (or fanout itself) records what went wrong so a
// person can do the post-mortem later. Stored in the ledger as `incident` and
// `incident_resolved` events, so DuckDB reads them like every other event.

export const KINDS = ['dispatch', 'worker', 'cost', 'limit', 'tooling', 'other'] as const
const SEVERITIES = ['low', 'medium', 'high'] as const
const TEXT_MAX = 4000

function usage(): string {
  return [
    'usage: fanout incident add --title <t> --what <text> [--job <id>] [--kind <k>] [--severity low|medium|high]',
    '                           [--expected <text>] [--tried <text>]',
    '       fanout incident list [--all]',
    '       fanout incident show <id>',
    '       fanout incident resolve <id> --note <text>',
    `kinds: ${KINDS.join(', ')}`
  ].join('\n')
}

function allEvents(): FanoutEvent[] {
  return readEvents(0)
}

export function openIncidents(events: FanoutEvent[] = allEvents()): FanoutEvent[] {
  const resolved = new Set(events.filter((e) => e.event === 'incident_resolved').map((e) => String(e.incident)))
  return events.filter((e) => e.event === 'incident' && !resolved.has(String(e.id)))
}

/** Record an incident; returns its id, or undefined when the ledger is unwritable. */
export function recordIncident(o: {
  title: string
  what: string
  kind?: string
  severity?: string
  job?: string
  expected?: string
  tried?: string
  source?: 'agent' | 'fanout'
}): string | undefined {
  if (!ledgerWritable()) {
    warnUnwritable()
    return undefined
  }
  const events = allEvents()
  const id = newId()
  const { caller, session } = detectCaller()
  const event: FanoutEvent = {
    v: 1,
    ts: nowIso(),
    event: 'incident',
    id,
    title: scrubText(o.title, 200),
    what: scrubText(o.what, TEXT_MAX),
    kind: o.kind ?? 'other',
    severity: o.severity ?? 'medium',
    source: o.source ?? 'agent',
    fanout_version: VERSION,
    cwd: process.cwd(),
    caller,
    ...(session !== undefined ? { session } : {})
  }
  if (o.expected) event.expected = scrubText(o.expected, TEXT_MAX)
  if (o.tried) event.tried = scrubText(o.tried, TEXT_MAX)
  if (o.job) {
    event.job = o.job
    const root = findChainRoot(o.job, events)
    if (root) {
      event.root = root
      const ends = events.filter((e) => e.event === 'job_end' && (e.root === root || e.job === root))
      const last = ends[ends.length - 1]
      if (last) {
        event.harness = last.harness
        event.model = last.model
        event.outcome = last.outcome
      }
    }
  }
  return appendEvent(event) ? id : undefined
}

function takeFlags(args: string[], names: string[]): { flags: Record<string, string>; rest: string[] } | string {
  const flags: Record<string, string> = {}
  const rest: string[] = []
  while (args.length > 0) {
    const a = args.shift() as string
    if (a.startsWith('--')) {
      const name = a.slice(2)
      if (name === 'all') {
        flags.all = '1'
        continue
      }
      if (!names.includes(name)) return `unknown option ${a}`
      const v = args.shift()
      if (v === undefined) return `${a} needs a value`
      flags[name] = v
    } else rest.push(a)
  }
  return { flags, rest }
}

function add(args: string[]): number {
  const parsed = takeFlags(args, ['title', 'what', 'job', 'kind', 'severity', 'expected', 'tried'])
  if (typeof parsed === 'string' || parsed.rest.length > 0) {
    console.error(typeof parsed === 'string' ? parsed : `unexpected ${parsed.rest[0]}`)
    console.error(usage())
    return 2
  }
  const f = parsed.flags
  if (!f.title || !f.what) {
    console.error('--title and --what are required')
    return 2
  }
  if (f.kind && !(KINDS as readonly string[]).includes(f.kind)) {
    console.error(`--kind must be one of ${KINDS.join(', ')}`)
    return 2
  }
  if (f.severity && !(SEVERITIES as readonly string[]).includes(f.severity)) {
    console.error('--severity must be low, medium or high')
    return 2
  }
  if (f.job && !findChainRoot(f.job, allEvents())) {
    console.error(`unknown job ${f.job}`)
    return 2
  }
  const id = recordIncident({ ...f, title: f.title, what: f.what })
  if (!id) return 1
  console.log(`INCIDENT ${id} recorded; a person reads it with: fanout incident show ${id}`)
  return 0
}

function list(args: string[]): number {
  const parsed = takeFlags(args, [])
  if (typeof parsed === 'string' || parsed.rest.length > 0) {
    console.error(usage())
    return 2
  }
  const events = allEvents()
  const shown = parsed.flags.all ? events.filter((e) => e.event === 'incident') : openIncidents(events)
  const resolved = new Set(events.filter((e) => e.event === 'incident_resolved').map((e) => String(e.incident)))
  if (shown.length === 0) {
    console.log(parsed.flags.all ? 'no incidents' : 'no open incidents')
    return 0
  }
  for (const e of shown) {
    const state = resolved.has(String(e.id)) ? 'resolved' : 'open'
    const job = e.job ? ` job=${String(e.job)}` : ''
    console.log(
      `${String(e.id)} ${String(e.ts).slice(0, 16)} ${state} ${String(e.severity)} ${String(e.kind)}${job} ${String(e.title)}`
    )
  }
  return 0
}

function show(args: string[]): number {
  const [id, ...rest] = args
  if (!id || rest.length > 0) {
    console.error(usage())
    return 2
  }
  const events = allEvents()
  const inc = events.find((e) => e.event === 'incident' && e.id === id)
  if (!inc) {
    console.error(`unknown incident ${id}`)
    return 2
  }
  const res = events.find((e) => e.event === 'incident_resolved' && e.incident === id)
  const out: string[] = [
    `INCIDENT ${id} (${res ? 'resolved' : 'open'})`,
    `title: ${String(inc.title)}`,
    `when: ${String(inc.ts)}  kind: ${String(inc.kind)}  severity: ${String(inc.severity)}  by: ${String(inc.source)}/${String(inc.caller)}`,
    `cwd: ${String(inc.cwd)}  fanout ${String(inc.fanout_version)}`,
    '',
    'what happened:',
    String(inc.what)
  ]
  if (inc.expected) out.push('', 'expected:', String(inc.expected))
  if (inc.tried) out.push('', 'already tried:', String(inc.tried))
  if (res) out.push('', `resolved ${String(res.ts)}: ${String(res.note)}`)
  const root = typeof inc.root === 'string' ? inc.root : undefined
  if (root) {
    out.push('', `chain ${root}:`)
    const chain = events.filter(
      (e) => (e.root === root || e.job === root) && e.event !== 'incident' && e.event !== 'incident_resolved'
    )
    for (const e of chain) {
      const bits = ['harness', 'model', 'effort', 'reason', 'outcome', 'detail', 'pattern', 'cost_usd', 'duration_s']
        .filter((k) => e[k] !== undefined && e[k] !== null)
        .map((k) => `${k}=${String(e[k])}`)
      out.push(`  ${String(e.ts).slice(11, 19)} ${String(e.event)} ${String(e.job ?? '')} ${bits.join(' ')}`)
      if (typeof e.stderr_tail === 'string' && e.stderr_tail.trim()) {
        out.push(`    stderr: ${e.stderr_tail.trim().split('\n').slice(-6).join('\n            ')}`)
      }
    }
    const jobs = [...new Set(chain.map((e) => String(e.job ?? '')).filter((j) => j))]
    const files: string[] = []
    for (const j of jobs) {
      for (const ext of ['block', 'chain', 'log', 'err', 'report.md']) {
        const p = join(dataDir(), 'logs', `${j}.${ext}`)
        if (existsSync(p)) files.push(p)
      }
      const patch = join(dataDir(), 'patches', `${j}.patch`)
      if (existsSync(patch)) files.push(patch)
    }
    if (files.length > 0) out.push('', 'files:', ...files.map((f) => `  ${f}`))
  }
  console.log(out.join('\n'))
  return 0
}

function resolve(args: string[]): number {
  const parsed = takeFlags(args, ['note'])
  if (typeof parsed === 'string' || parsed.rest.length !== 1 || !parsed.flags.note) {
    console.error('usage: fanout incident resolve <id> --note <text>')
    return 2
  }
  const id = parsed.rest[0]
  const events = allEvents()
  if (!events.some((e) => e.event === 'incident' && e.id === id)) {
    console.error(`unknown incident ${id}`)
    return 2
  }
  if (events.some((e) => e.event === 'incident_resolved' && e.incident === id)) {
    console.log(`ALREADY ${id}`)
    return 0
  }
  if (!ledgerWritable()) {
    warnUnwritable()
    return 1
  }
  const { caller, session } = detectCaller()
  appendEvent({
    v: 1,
    ts: nowIso(),
    event: 'incident_resolved',
    id: newId(),
    incident: id,
    note: scrubText(parsed.flags.note, TEXT_MAX),
    caller,
    ...(session !== undefined ? { session } : {})
  })
  console.log(`RESOLVED ${id}`)
  return 0
}

export async function runIncident(args: string[]): Promise<number> {
  const [sub, ...rest] = args
  if (sub === 'add') return add(rest)
  if (sub === 'list') return list(rest)
  if (sub === 'show') return show(rest)
  if (sub === 'resolve') return resolve(rest)
  console.error(usage())
  return 2
}

registerCommand('incident', runIncident)
