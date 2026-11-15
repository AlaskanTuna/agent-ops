export const DAY_MS = 24 * 3600 * 1000
export const LEDGER_WINDOW_MS = 30 * DAY_MS

let virtualOffsetMs = 0

export function nowMs(): number {
  const forced = process.env.FANOUT_NOW
  let base = Date.now()
  if (forced) {
    const ms = Date.parse(forced)
    if (!Number.isNaN(ms)) base = ms
  }
  return base + virtualOffsetMs
}

export function nowIso(): string {
  return new Date(nowMs()).toISOString()
}

export async function sleepClock(ms: number): Promise<void> {
  if (process.env.FANOUT_NO_SLEEP === '1') {
    virtualOffsetMs += ms
    return
  }
  await new Promise((r) => setTimeout(r, ms))
}
