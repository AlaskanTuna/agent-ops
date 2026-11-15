export const DAY_MS = 24 * 3600 * 1000
export const LEDGER_WINDOW_MS = 30 * DAY_MS

export function nowMs(): number {
  const forced = process.env.FANOUT_NOW
  if (forced) {
    const ms = Date.parse(forced)
    if (!Number.isNaN(ms)) return ms
  }
  return Date.now()
}

export function nowIso(): string {
  return new Date(nowMs()).toISOString()
}
