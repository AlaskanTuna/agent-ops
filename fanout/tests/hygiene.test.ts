import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

function gitLsFiles(): string[] {
  const p = spawnSync('git', ['ls-files'], { encoding: 'utf8' })
  if (p.status !== 0) throw new Error(`git ls-files failed: ${p.stderr}`)
  return p.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

const RULES: [string, RegExp][] = [
  ['absolute home path', /\/home\/[a-z]|\/Users\/|C:\\Users/],
  ['email address', /[\w.+-]+@[\w-]+\.[a-z]{2,}/],
  ['api key shape', /\bAIza[\w-]{30,}|\bsk-[\w-]{16,}|Bearer [\w.-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY/],
  ['secret assignment', /(api[_-]?key|token|secret|password)\s*[=:]\s*["']?[\w-]{20,}/]
]

function scrubbed(content: string): string {
  return content
    .replace(/@users\.noreply\.github\.com/g, '')
    .replace(/@example\.com/g, '')
    .replace(/@example\.invalid/g, '')
}

test('runtime artefacts are git-ignored', () => {
  for (const p of [
    'fanout/.tmp/x',
    'fanout/dist/fanout.js',
    'x/status.json',
    'a/errors.log',
    'run/J.lease',
    'logs/J.block',
    'patches/J.patch',
    'secrets.env',
    'k.pem',
    'events/2026-11.jsonl',
    'learned/state.jsonl',
    'mined/pairs.jsonl',
    'a.duckdb'
  ])
    expect(spawnSync('git', ['check-ignore', '-q', p]).status).toBe(0)
})

test('no tracked file carries a secret, an email, or an absolute home path', () => {
  const files = gitLsFiles().filter(
    (f) => !/^(\.agents|\.claude)\//.test(f) && !['bun.lock', 'skills-lock.json'].includes(f)
  )
  const bad: string[] = []
  for (const f of files) {
    let content = ''
    try {
      content = readFileSync(f, 'utf8')
    } catch {
      continue
    }
    content = scrubbed(content)
    for (const [name, re] of RULES) if (re.test(content)) bad.push(`${f}: ${name}`)
  }
  expect(bad).toEqual([])
})

test('no ledger, database, log or env file is tracked', () => {
  expect(
    gitLsFiles().filter(
      (f) =>
        /\.(jsonl|duckdb|log|lease|patch|block)$|(^|\/)(status\.json|\.env[^/]*|secrets\.env)$/.test(f) &&
        !f.endsWith('.env.example')
    )
  ).toEqual([])
})
