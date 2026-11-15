import { test, expect } from 'bun:test'
import { mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { sandbox } from './helpers/sandbox'

test('--version prints the version and exits 0', async () => {
  const r = await sandbox().fanout(['--version'])
  expect(r.code).toBe(0)
  expect(r.stdout.trim()).toBe('fanout 0.1.0')
})

test('unknown command exits 2 with usage on stderr', async () => {
  const r = await sandbox().fanout(['frobnicate'])
  expect(r.code).toBe(2)
  expect(r.stderr).toMatch(/usage: fanout <command>/i)
})

test('the bin shim works through a symlink from another cwd', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fanout-link-'))
  symlinkSync(resolve(import.meta.dir, '../bin/fanout'), join(tmp, 'linked'))
  const p = Bun.spawnSync([join(tmp, 'linked'), '--version'], { cwd: tmp })
  expect(p.exitCode).toBe(0)
  expect(p.stdout.toString().trim()).toBe('fanout 0.1.0')
})
