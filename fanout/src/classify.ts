import type { Adapter, Classified, Outcome, RunOutput } from './adapters/types'

import genericJson from '../patterns/generic.json'

export interface Rule {
  id: string
  re: string
  outcome: Outcome
  scope?: 'model' | 'account'
  onExit0?: boolean
  cooldownS?: number
}

function genericRules(): Rule[] {
  try {
    const rules = (genericJson as { rules: Rule[] }).rules
    return Array.isArray(rules) ? rules : []
  } catch {
    return []
  }
}

function adapterRules(adapter: Adapter): Rule[] {
  try {
    const rules = (adapter as unknown as { rules?: Rule[] }).rules
    return Array.isArray(rules) ? rules : []
  } catch {
    return []
  }
}

export function defaultScope(outcome: Outcome): 'model' | 'account' {
  if (outcome === 'credits_exhausted' || outcome === 'auth_error') return 'account'
  return 'model'
}

function tzOffsetMs(tz: string, dateMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
  const parts: Record<string, string> = {}
  for (const p of dtf.formatToParts(new Date(dateMs))) {
    if (p.type !== 'literal') parts[p.type] = p.value
  }
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  )
  return asUTC - dateMs
}

function localParts(tz: string, dateMs: number): { year: number; month: number; day: number } {
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
  const parts: Record<string, string> = {}
  for (const p of dtf.formatToParts(new Date(dateMs))) {
    if (p.type !== 'literal') parts[p.type] = p.value
  }
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) }
}

function clockResetMs(hour: number, minute: number, nowMs: number): number {
  const tz = process.env.TZ || 'UTC'
  const { year, month, day } = localParts(tz, nowMs)
  const wallUtc = Date.UTC(year, month - 1, day, hour, minute)
  let guess = wallUtc - tzOffsetMs(tz, nowMs)
  guess = wallUtc - tzOffsetMs(tz, guess)
  if (guess <= nowMs) guess = wallUtc + 24 * 3600 * 1000 - tzOffsetMs(tz, guess + 24 * 3600 * 1000)
  return guess
}

export function parseReset(text: string, nowMs: number): number | undefined {
  const retry = /retry-after:\s*(\d+)/i.exec(text)
  if (retry) return nowMs + Number(retry[1]) * 1000
  const again = /try again in\s+(?:(\d+)\s*hours?)?\s*(?:(\d+)\s*minutes?)?/i.exec(text)
  if (again && (again[1] !== undefined || again[2] !== undefined)) {
    const hours = again[1] !== undefined ? Number(again[1]) : 0
    const minutes = again[2] !== undefined ? Number(again[2]) : 0
    if (hours > 0 || minutes > 0) return nowMs + (hours * 3600 + minutes * 60) * 1000
  }
  const againAt = /try again at (\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(text)
  if (againAt) {
    let hour = Number(againAt[1])
    const minute = Number(againAt[2])
    const meridiem = againAt[3].toUpperCase()
    if (meridiem === 'PM' && hour < 12) hour += 12
    if (meridiem === 'AM' && hour === 12) hour = 0
    if (hour <= 23 && minute <= 59) return clockResetMs(hour, minute, nowMs)
  }
  const inHow = /resets?\s+in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i.exec(text)
  if (inHow && (inHow[1] !== undefined || inHow[2] !== undefined)) {
    const hours = inHow[1] !== undefined ? Number(inHow[1]) : 0
    const minutes = inHow[2] !== undefined ? Number(inHow[2]) : 0
    if (hours > 0 || minutes > 0) return nowMs + (hours * 3600 + minutes * 60) * 1000
  }
  const clock =
    /resets?\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(text) ??
    /resets?\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(text)
  if (clock) {
    let hour = Number(clock[1])
    const minute = Number(clock[2])
    const meridiem = clock[3]?.toUpperCase()
    if (meridiem === 'PM' && hour < 12) hour += 12
    if (meridiem === 'AM' && hour === 12) hour = 0
    if (hour <= 23 && minute <= 59) return clockResetMs(hour, minute, nowMs)
  }
  const iso = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/.exec(text)
  if (iso) {
    const ms = Date.parse(iso[0])
    if (!Number.isNaN(ms)) return ms
  }
  return undefined
}

export function classify(adapter: Adapter, out: RunOutput, nowMs: number): Classified {
  if (out.timedOut) return { outcome: 'timeout' }
  const rules = [...adapterRules(adapter), ...genericRules()]
  const cleanExit = out.exit === 0
  const text = `${out.stderr}\n${out.stdout.slice(-2048)}`
  for (const rule of rules) {
    if (cleanExit && !rule.onExit0) continue
    let re: RegExp
    try {
      re = new RegExp(rule.re, 'i')
    } catch {
      continue
    }
    if (!re.test(text)) continue
    const scope = rule.scope ?? defaultScope(rule.outcome)
    const result: Classified = { outcome: rule.outcome, scope, pattern: rule.id }
    for (const line of text.split('\n')) {
      if (re.test(line)) {
        result.match = line.slice(0, 120)
        break
      }
    }
    if (rule.cooldownS !== undefined) result.cooldownS = rule.cooldownS
    const until = parseReset(text, nowMs)
    if (until !== undefined) result.until = until
    return result
  }
  return { outcome: cleanExit ? 'ok' : 'unknown' }
}
