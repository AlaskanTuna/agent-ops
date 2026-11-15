import denylistJson from '../../patterns/denylist.json'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { LEDGER_WINDOW_MS, nowIso, nowMs } from '../clock'
import { appendEvent, readEvents } from '../events'
import { dataDir } from '../paths'
import { newId } from '../ulid'
import { registerStep, type StepCtx } from './index'
import type { Rule } from '../classify'

export interface LearnedRule extends Rule {
  harness: string
  adopted_at: string
  last_match: string
}

const SIXTY_DAYS_MS = 60 * 24 * 3600 * 1000

export function readLearnedRules(): LearnedRule[] {
  try {
    const path = join(dataDir(), 'learned', 'patterns.json')
    if (!existsSync(path)) return []
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { rules?: unknown }
    if (!Array.isArray(parsed.rules)) return []
    return parsed.rules.filter(
      (r): r is LearnedRule =>
        r !== null &&
        typeof r === 'object' &&
        typeof (r as LearnedRule).id === 'string' &&
        typeof (r as LearnedRule).harness === 'string' &&
        typeof (r as LearnedRule).re === 'string'
    )
  } catch {
    return []
  }
}

function writeLearnedRules(rules: LearnedRule[]): void {
  const path = join(dataDir(), 'learned', 'patterns.json')
  mkdirSync(join(dataDir(), 'learned'), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ rules }) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

function readDenylist(): RegExp[] {
  const out: RegExp[] = []
  try {
    const parsed = denylistJson as {
      lines?: unknown
    }
    if (!Array.isArray(parsed.lines)) return out
    for (const l of parsed.lines) {
      if (typeof l !== 'string' || l === '') continue
      try {
        out.push(new RegExp(l))
      } catch {
        // a bad denylist line never stops learning
      }
    }
  } catch {
    // a missing denylist means nothing is denied
  }
  return out
}

function denied(line: string, deny: RegExp[]): boolean {
  for (const re of deny) {
    try {
      if (re.test(line)) return true
    } catch {
      if (line.includes(re.source)) return true
    }
  }
  return false
}

const PLACEHOLDERS: [string, string][] = [
  ['__UUID__', '[0-9a-fA-F-]{36}'],
  ['__HEX__', '0x[0-9a-fA-F]+'],
  ['__NUM__', '\\d+'],
  ['__PATH__', '\\S+']
]

/** Normalize one stderr line into a regex source. Numbers, UUIDs, hex and paths become classes. */
export function normalizeLine(line: string): string {
  let s = line
  s = s.replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, '__UUID__')
  s = s.replace(/\b0x[0-9a-fA-F]+\b/g, '__HEX__')
  s = s.replace(/(?:[~.]?\/[\w.\-]+)+(?:\/)?/g, '__PATH__')
  s = s.replace(/\b\d+\b/g, '__NUM__')
  s = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const [from, to] of PLACEHOLDERS) s = s.split(from).join(to)
  return s
}

/** The signature of an unknown job end: the last stderr line the denylist allows. */
export function signatureFor(stderrTail: string, deny: RegExp[]): string | undefined {
  const lines = stderrTail
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (denied(lines[i], deny)) continue
    return normalizeLine(lines[i])
  }
  return undefined
}

function ruleId(harness: string, re: string): string {
  return `learned-${createHash('sha256').update(`${harness}\n${re}`).digest('hex').slice(0, 12)}`
}

export async function runPatterns(): Promise<string> {
  const now = nowMs()
  const events = readEvents(now - LEDGER_WINDOW_MS)
  const deny = readDenylist()
  const groups = new Map<string, { harness: string; re: string; chains: Set<string>; count: number }>()
  for (const e of events) {
    if (e.event !== 'job_end' || e.outcome !== 'unknown' || typeof e.stderr_tail !== 'string') continue
    const harness = typeof e.harness === 'string' ? e.harness : ''
    if (harness === '') continue
    const sig = signatureFor(e.stderr_tail, deny)
    if (sig === undefined) continue
    const root = typeof e.root === 'string' ? e.root : String(e.job)
    const key = `${harness}\n${sig}`
    const g = groups.get(key) ?? { harness, re: sig, chains: new Set<string>(), count: 0 }
    g.chains.add(root)
    g.count += 1
    groups.set(key, g)
  }
  const existing = readLearnedRules()
  const have = new Set(existing.map((r) => `${r.harness}\n${r.re}`))
  const rules = [...existing]
  let adopted = 0
  for (const g of groups.values()) {
    if (g.count < 3 || g.chains.size < 2) continue
    if (have.has(`${g.harness}\n${g.re}`)) continue
    const id = ruleId(g.harness, g.re)
    rules.push({
      id,
      harness: g.harness,
      re: g.re,
      outcome: 'worker_error',
      adopted_at: nowIso(),
      last_match: nowIso()
    })
    have.add(`${g.harness}\n${g.re}`)
    adopted += 1
    appendEvent({
      v: 1,
      ts: nowIso(),
      event: 'pattern_learned',
      id: newId(),
      harness: g.harness,
      regex: g.re,
      outcome: 'worker_error'
    })
  }
  const matchTs = new Map<string, number>()
  for (const e of events) {
    if (e.event !== 'job_end' || typeof e.pattern !== 'string') continue
    const ts = Date.parse(String(e.ts))
    if (Number.isNaN(ts)) continue
    const prev = matchTs.get(e.pattern) ?? -Infinity
    if (ts > prev) matchTs.set(e.pattern, ts)
  }
  const kept: LearnedRule[] = []
  let expired = 0
  for (const r of rules) {
    const last = Math.max(matchTs.get(r.id) ?? -Infinity, Date.parse(r.last_match))
    if (Number.isFinite(last) && now - last > SIXTY_DAYS_MS) {
      expired += 1
      appendEvent({ v: 1, ts: nowIso(), event: 'pattern_expired', id: r.id })
      continue
    }
    const latest = matchTs.get(r.id)
    kept.push(latest !== undefined ? { ...r, last_match: new Date(latest).toISOString() } : r)
  }
  if (adopted > 0 || expired > 0) writeLearnedRules(kept)
  return `${adopted} adopted, ${expired} expired`
}

export function registerPatternsStep(): void {
  registerStep('patterns', runPatterns)
}
