import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runChain, runDetached } from '../run'
import { registerCommand } from '../cli'

function usage(): string {
  return 'usage: fanout run --brief <file> --dir <dir> --kind <kind> [options]'
}

export async function runRun(rawArgs: string[]): Promise<number> {
  let brief = ''
  let dir = ''
  let kind = ''
  let dataClass: 'public' | 'private' | undefined
  let timeoutS: number | undefined
  let startTier: number | undefined
  let detach = false
  let root: string | undefined
  let maxAttempts: number | undefined
  let model: string | undefined
  let harness: string | undefined
  let pin = false
  let expect: string | undefined
  let escalateFrom: string | undefined
  let effort: string | undefined
  let noPaid = false
  let maxTurns: number | undefined
  let bypass = false
  let dryRun = false
  const allow: string[] = []
  const args = [...rawArgs]
  while (args.length > 0) {
    const a = args.shift()
    if (a === '--brief') brief = args.shift() ?? ''
    else if (a === '--dir') dir = args.shift() ?? ''
    else if (a === '--kind') kind = args.shift() ?? ''
    else if (a === '--model') model = args.shift() ?? ''
    else if (a === '--harness') harness = args.shift() ?? ''
    else if (a === '--pin') pin = true
    else if (a === '--expect') expect = args.shift() ?? ''
    else if (a === '--escalate-from') escalateFrom = args.shift() ?? ''
    else if (a === '--effort') effort = args.shift() ?? ''
    else if (a === '--no-paid') noPaid = true
    else if (a === '--max-turns') {
      const n = Number(args.shift() ?? '')
      if (!Number.isFinite(n) || n <= 0) {
        console.error(usage())
        return 2
      }
      maxTurns = Math.floor(n)
    } else if (a === '--allow') allow.push(args.shift() ?? '')
    else if (a === '--bypass') bypass = true
    else if (a === '--dry-run') dryRun = true
    else if (a === '--tier') {
      const t = Number(args.shift() ?? '')
      if (t !== 1 && t !== 2 && t !== 3) {
        console.error(usage())
        return 2
      }
      startTier = t
    } else if (a === '--timeout') {
      const t = Number(args.shift() ?? '')
      if (!Number.isFinite(t) || t <= 0) {
        console.error(usage())
        return 2
      }
      timeoutS = t
    } else if (a === '--detach') detach = true
    else if (a === '--root') root = args.shift() ?? ''
    else if (a === '--max-attempts') {
      const n = Number(args.shift() ?? '')
      if (!Number.isFinite(n) || n < 1) {
        console.error('--max-attempts must be 1 or more')
        return 2
      }
      maxAttempts = Math.floor(n)
    } else if (a === '--public' || a === '--private') {
      if (dataClass) {
        console.error('--public and --private conflict')
        return 2
      }
      dataClass = a === '--public' ? 'public' : 'private'
    } else {
      console.error(usage())
      return 2
    }
  }
  if (!brief || !dir || !kind) {
    console.error(usage())
    return 2
  }
  if (escalateFrom && (model || pin)) {
    console.error('--escalate-from cannot be combined with --model or --pin')
    return 2
  }
  if (!existsSync(brief)) {
    console.error(`cannot read brief ${brief}`)
    return 2
  }
  if (detach) {
    const passthrough = rawArgs.filter((a) => a !== '--detach')
    const { code } = await runDetached({ brief, dir, kind, dataClass, timeoutS, startTier }, passthrough)
    return code
  }
  const { code } = await runChain({
    brief,
    dir,
    kind,
    dataClass,
    timeoutS,
    startTier,
    root,
    maxAttempts,
    model,
    harness,
    pin,
    expect,
    escalateFrom,
    effort,
    noPaid,
    maxTurns,
    allow,
    bypass,
    dryRun
  })
  return code
}

registerCommand('run', runRun)
