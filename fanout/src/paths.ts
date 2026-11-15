import { homedir } from 'node:os'
import { join } from 'node:path'

export function homeDir(): string {
  return process.env.HOME ?? homedir()
}

export function dataDir(): string {
  return process.env.FANOUT_HOME ?? join(homeDir(), '.local', 'share', 'agent-ops', 'fanout')
}

export function privateCatalogPath(): string {
  return join(homeDir(), '.config', 'agent-ops', 'catalog.csv')
}

export function autoCatalogPath(): string {
  return join(dataDir(), 'learned', 'catalog.auto.json')
}

export function runDir(): string {
  return join(dataDir(), 'run')
}

export function catalogOverridePath(): string | undefined {
  return process.env.FANOUT_CATALOG_FILE || undefined
}
