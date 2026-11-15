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
