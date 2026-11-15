import { existsSync } from 'node:fs'
import { runChain } from '../run'
import { registerCommand } from '../cli'

function usage(): string {
  return 'usage: fanout run --brief <file> --dir <dir> --kind <kind> [options]'
}

export async function runRun(rawArgs: string[]): Promise<number> {
  let brief = ''
  let dir = ''
  let kind = ''
  let dataClass: 'public' | 'private' | undefined
  const args = [...rawArgs]
  while (args.length > 0) {
    const a = args.shift()
    if (a === '--brief') brief = args.shift() ?? ''
    else if (a === '--dir') dir = args.shift() ?? ''
    else if (a === '--kind') kind = args.shift() ?? ''
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
  const { code } = await runChain({ brief, dir, kind, dataClass })
  return code
}

registerCommand('run', runRun)
