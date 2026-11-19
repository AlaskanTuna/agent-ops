import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir, homeDir, privateCatalogPath } from '../paths'
import { registerStep, StepSkipped } from './index'

// Push the private catalog to the machines listed in
// ~/.config/agent-ops/sync-hosts (one ssh host per line, # comments).
// A remote copy is replaced only when it is missing or still equals what
// this step pushed last time, so an edit made on the other machine is
// never overwritten: it is reported as a conflict instead.

const REMOTE = '.config/agent-ops/catalog.csv'

function hostsPath(): string {
  return join(homeDir(), '.config', 'agent-ops', 'sync-hosts')
}

function statePath(): string {
  return join(dataDir(), 'learned', 'sync.json')
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function readState(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function ssh(host: string, command: string, stdin?: string): { ok: boolean; out: string } {
  const bin = process.env.FANOUT_SSH ?? 'ssh'
  const p = Bun.spawnSync([bin, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, command], {
    stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin),
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: 30000
  })
  return { ok: p.exitCode === 0, out: p.stdout.toString() }
}

export async function runSync(): Promise<string> {
  if (!existsSync(hostsPath())) throw new StepSkipped('no sync-hosts file')
  const hosts = readFileSync(hostsPath(), 'utf8')
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter((l) => /^[A-Za-z0-9._@-]+$/.test(l))
  if (hosts.length === 0) throw new StepSkipped('sync-hosts lists no host')
  if (!existsSync(privateCatalogPath())) throw new StepSkipped('no private catalog')
  const text = readFileSync(privateCatalogPath(), 'utf8')
  const local = sha(text)
  const state = readState()
  const results: string[] = []
  const conflicts: string[] = []
  for (const host of hosts) {
    const probe = ssh(host, `if [ -f ${REMOTE} ]; then sha256sum ${REMOTE}; else echo missing; fi`)
    if (!probe.ok) {
      results.push(`${host} unreachable`)
      continue
    }
    const remote = probe.out.trim() === 'missing' ? undefined : probe.out.trim().split(/\s+/)[0]
    if (remote === local) {
      state[host] = local
      results.push(`${host} in sync`)
      continue
    }
    if (remote !== undefined && remote !== state[host]) {
      conflicts.push(host)
      results.push(`${host} not overwritten: its catalog was edited there`)
      continue
    }
    const push = ssh(
      host,
      `mkdir -p .config/agent-ops && cat > ${REMOTE}.fanout-sync && mv ${REMOTE}.fanout-sync ${REMOTE}`,
      text
    )
    if (!push.ok) {
      results.push(`${host} push failed`)
      continue
    }
    state[host] = local
    results.push(`${host} pushed`)
  }
  mkdirSync(join(dataDir(), 'learned'), { recursive: true, mode: 0o700 })
  writeFileSync(statePath(), JSON.stringify(state) + '\n', { mode: 0o600 })
  const summary = results.join(', ')
  if (conflicts.length > 0) throw new Error(`${summary}. Merge by hand, then copy it over once`)
  return summary
}

export function registerSyncStep(): void {
  registerStep('sync', runSync)
}
