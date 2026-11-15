// Minimal wrapper around the DuckDB CLI. Analytics only; the hot path never calls this.
// The child gets PATH only, never the caller's secrets or worker env.
export const DUCKDB_MISSING = 'duckdb not found; reports are unavailable (the ledger and run are unaffected)'

function minimalEnv(): Record<string, string> {
  const path = process.env.PATH ?? ''
  return path ? { PATH: path } : {}
}

export async function duckdbJson(sql: string): Promise<Record<string, unknown>[]> {
  let proc: ReturnType<typeof Bun.spawnSync>
  try {
    proc = Bun.spawnSync(['duckdb', '-no-agent', '-json', '-c', sql], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: minimalEnv()
    })
  } catch {
    throw new Error(DUCKDB_MISSING)
  }
  if (proc.exitCode !== 0) throw new Error(DUCKDB_MISSING)
  const text = proc.stdout?.toString().trim() ?? ''
  if (!text) return []
  return JSON.parse(text) as Record<string, unknown>[]
}
