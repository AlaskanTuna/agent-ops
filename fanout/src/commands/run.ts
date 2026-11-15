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
  const args = [...rawArgs]
  while (args.length > 0) {
    const a = args.shift()
    if (a === '--brief') brief = args.shift() ?? ''
    else if (a === '--dir') dir = args.shift() ?? ''
    else if (a === '--kind') kind = args.shift() ?? ''
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
    else if (a === '--public' || a === '--private') {
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
  if (!existsSync(brief)) {
    console.error(`cannot read brief ${brief}`)
    return 2
  }
  if (detach) {
    const passthrough = rawArgs.filter((a) => a !== '--detach')
    const { code } = await runDetached({ brief, dir, kind, dataClass, timeoutS, startTier }, passthrough)
    return code
  }
  const { code } = await runChain({ brief, dir, kind, dataClass, timeoutS, startTier, root })
  return code
}

registerCommand('run', runRun)
