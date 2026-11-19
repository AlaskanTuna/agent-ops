import { test, expect } from 'bun:test'
import { sandbox } from './helpers/sandbox'

const BASE = '2026-11-19T01:00:00Z'

function runArgs(sb: ReturnType<typeof sandbox>): string[] {
  return [
    'run',
    '--brief',
    sb.brief('Rename foo in a.txt to bar, nothing else.'),
    '--dir',
    sb.repo,
    '--kind',
    'transcribe'
  ]
}

test('an incident is added, listed, shown with its chain, and resolved', async () => {
  const sb = sandbox().at(BASE)
  sb.script({ 'fake/f1-a': ['auth_error'] })
  const run = await sb.fanout([...runArgs(sb), '--model', 'fake/f1-a', '--pin'])
  const job = /FANOUT job=(\w+)/.exec(run.stdout)?.[1] as string
  // A FAILED block tells the agent how to report it.
  expect(run.stdout).toContain(`INCIDENT if this was not expected, record it: fanout incident add --job ${job}`)

  const add = await sb.fanout([
    'incident',
    'add',
    '--job',
    job,
    '--kind',
    'worker',
    '--severity',
    'high',
    '--title',
    'worker refused a tiny rename',
    '--what',
    'auth_error on a one-line brief; the key was api_key=abcd1234efgh5678',
    '--expected',
    'a one-line patch'
  ])
  expect(add.code).toBe(0)
  const id = /INCIDENT (\w+) recorded/.exec(add.stdout)?.[1] as string
  expect(id).toBeTruthy()

  const list = await sb.fanout(['incident', 'list'])
  expect(list.stdout).toMatch(new RegExp(`^${id} .* open high worker job=${job} worker refused a tiny rename$`, 'm'))

  const status = await sb.fanout(['status', '--brief'])
  expect(status.stdout).toContain('INCIDENTS 1 open, latest: worker refused a tiny rename')

  const show = await sb.fanout(['incident', 'show', id])
  expect(show.stdout).toContain('what happened:')
  expect(show.stdout).toContain('api_key=[secret]')
  expect(show.stdout).not.toContain('abcd1234efgh5678')
  expect(show.stdout).toContain('expected:\na one-line patch')
  expect(show.stdout).toMatch(/job_end .*outcome=auth_error/)
  expect(show.stdout).toMatch(/files:\n {2}\S+\.(block|log|err|chain)/)

  const res = await sb.fanout(['incident', 'resolve', id, '--note', 'brief was malformed; fixed the template'])
  expect(res.stdout).toBe(`RESOLVED ${id}\n`)
  expect((await sb.fanout(['incident', 'list'])).stdout).toBe('no open incidents\n')
  expect((await sb.fanout(['incident', 'list', '--all'])).stdout).toContain(`${id} `)
  expect((await sb.fanout(['status', '--brief'])).stdout).not.toContain('INCIDENTS')
  const led = sb.ledger().filter((e) => e.event === 'incident' || e.event === 'incident_resolved')
  expect(led.map((e) => e.event)).toEqual(['incident', 'incident_resolved'])
}, 60000)

test('bad input is refused without writing anything', async () => {
  const sb = sandbox().at(BASE)
  expect((await sb.fanout(['incident', 'add', '--title', 'x'])).code).toBe(2)
  expect((await sb.fanout(['incident', 'add', '--title', 'x', '--what', 'y', '--kind', 'nope'])).code).toBe(2)
  expect((await sb.fanout(['incident', 'add', '--title', 'x', '--what', 'y', '--job', 'NOSUCHJOB'])).code).toBe(2)
  expect(sb.ledger().filter((e) => e.event === 'incident')).toHaveLength(0)
}, 30000)
