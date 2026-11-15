import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

const SKILL = new URL('../skill/SKILL.md', import.meta.url).pathname
const README = new URL('../README.md', import.meta.url).pathname
const ROOT_README = new URL('../../README.md', import.meta.url).pathname

const RULES: [string, RegExp][] = [
  ['home path', /\/home\/[a-z]|\/Users\/|C:\\Users/],
  ['email', /[\w.+-]+@[\w-]+\.[a-z]{2,}/],
  ['key shape', /\bAIza[\w-]{30,}|\bsk-[\w-]{16,}|Bearer [\w.-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY/],
  ['secret assignment', /(api[_-]?key|token|secret|password)\s*[=:]\s*["']?[\w-]{20,}/]
]

function clean(text: string): string {
  return text
    .replaceAll('@users.noreply.github.com', '')
    .replaceAll('@example.com', '')
    .replaceAll('@example.invalid', '')
}

test('the skill has the right frontmatter and size', () => {
  const text = readFileSync(SKILL, 'utf8')
  const lines = text.split('\n')
  expect(lines[0]).toBe('---')
  expect(text).toMatch(/^name: fanout$/m)
  expect(text).toMatch(/^description: /m)
  expect(lines.length).toBeLessThanOrEqual(150)
})

test('the skill names every command and rule', () => {
  const text = readFileSync(SKILL, 'utf8')
  for (const s of [
    'fanout pick',
    'fanout run',
    '--expect',
    '--detach',
    'fanout wait',
    'fanout ack',
    'fanout verdict',
    '--escalate-from',
    '--pin',
    'benchmarks import',
    'FALLBACK',
    'COST',
    'job_error',
    'no_effect',
    'PAID'
  ])
    expect(text, s).toContain(s)
})

test('the skill and the README carry no personal path or key', () => {
  for (const f of [SKILL, README]) {
    const text = clean(readFileSync(f, 'utf8'))
    for (const [name, re] of RULES) expect(text, `${f}: ${name}`).not.toMatch(re)
  }
})

test('the README is short and credits the source', () => {
  const text = readFileSync(README, 'utf8')
  expect(text.split('\n').length).toBeLessThanOrEqual(80)
  expect(text).toContain('Benchmark data: [Artificial Analysis](https://artificialanalysis.ai/)')
})

test('the root README says fanout is built', () => {
  const text = readFileSync(ROOT_README, 'utf8')
  expect(text).not.toContain('Status: design')
  expect(text).toContain('fanout/README.md')
})
