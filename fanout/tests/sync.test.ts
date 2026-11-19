import { test, expect } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sandbox } from './helpers/sandbox'

type SB = ReturnType<typeof sandbox>

// The stub plays the remote machine: it runs the remote command in a local
// "remote home" folder, with stdin passed through.
function remote(sb: SB): string {
  const home = join(sb.home, 'remote-home')
  mkdirSync(home, { recursive: true })
  sb.bin('fake-ssh', `#!/bin/sh\nfor last; do :; done\ncd "${home}" && sh -c "$last"\n`)
  writeFileSync(join(sb.home, '.config', 'agent-ops', 'sync-hosts'), '# machines to keep in step\ndev1\n')
  return home
}

const remoteCatalog = (home: string) => join(home, '.config', 'agent-ops', 'catalog.csv')

async function sync(sb: SB) {
  return sb.fanout(['upkeep', '--only', 'sync'], { env: { FANOUT_SSH: join(sb.home, 'bin', 'fake-ssh') } })
}

function syncStatus(sb: SB): Record<string, unknown> | undefined {
  return sb
    .ledger()
    .filter((e) => e.event === 'upkeep' && e.step === 'sync')
    .pop()
}

test('the private catalog is pushed, kept in step, and never overwrites a remote edit', async () => {
  const sb = sandbox().at('2026-11-19T01:00:00Z')
  sb.catalogPrivate('harness,model,tier\nfake,f1-a,2\n')
  const home = remote(sb)

  await sync(sb)
  expect(readFileSync(remoteCatalog(home), 'utf8')).toBe('harness,model,tier\nfake,f1-a,2\n')
  expect(syncStatus(sb)).toMatchObject({ status: 'ok' })

  sb.catalogPrivate('harness,model,tier\nfake,f1-a,3\n')
  await sync(sb)
  expect(readFileSync(remoteCatalog(home), 'utf8')).toContain('fake,f1-a,3')

  // Someone edits the catalog on the remote machine: the next local change must not clobber it.
  writeFileSync(remoteCatalog(home), 'harness,model,tier\nfake,f1-a,1\n')
  sb.catalogPrivate('harness,model,tier\nfake,f1-a,2\n')
  await sync(sb)
  expect(readFileSync(remoteCatalog(home), 'utf8')).toContain('fake,f1-a,1')
  const last = syncStatus(sb)
  expect(last).toMatchObject({ status: 'failed' })
  expect(String(last?.detail ?? last?.error ?? '')).toContain('dev1 not overwritten')
}, 60000)

test('no sync-hosts file skips the step', async () => {
  const sb = sandbox().at('2026-11-19T01:00:00Z')
  sb.catalogPrivate('harness,model,tier\nfake,f1-a,2\n')
  await sync(sb)
  expect(syncStatus(sb)).toMatchObject({ status: 'skipped' })
  expect(existsSync(join(sb.home, 'remote-home'))).toBe(false)
}, 30000)
