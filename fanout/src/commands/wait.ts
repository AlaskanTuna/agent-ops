import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerCommand } from '../cli'
import { dataDir } from '../paths'
import { leasePath } from '../lease'
import { chainExitCode, findChain } from '../run'

function usage(): string {
  return 'usage: fanout wait <job> [--max <s>]'
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export async function runWait(rawArgs: string[]): Promise<number> {
  let job = ''
  let max: number | undefined
  const args = [...rawArgs]
  while (args.length > 0) {
    const a = args.shift()
    if (a === undefined) break
    if (a === '--max') {
      const n = Number(args.shift() ?? '')
      if (!Number.isFinite(n) || n < 0) {
        console.error(usage())
        return 2
      }
      max = n
    } else if (a.startsWith('--')) {
      console.error(usage())
      return 2
    } else if (!job && a) {
      job = a
    } else {
      console.error(usage())
      return 2
    }
  }
  if (!job) {
    console.error(usage())
    return 2
  }
  const chain = findChain(job)
  if (!chain) {
    console.error(`unknown job ${job}`)
    return 2
  }
  const { root } = chain
  const envMax = Number(process.env.FANOUT_WAIT_MAX_S)
  const maxS = max ?? (Number.isFinite(envMax) && envMax >= 0 ? envMax : 540)
  const start = Date.now()
  for (;;) {
    if (!existsSync(leasePath(root))) {
      const blockPath = join(dataDir(), 'logs', `${root}.block`)
      if (!existsSync(blockPath)) {
        console.log(`NOTE no result block for ${root}`)
        return 1
      }
      console.log(readFileSync(blockPath, 'utf8'))
      return chainExitCode(root)
    }
    const elapsedS = Math.floor((Date.now() - start) / 1000)
    if (elapsedS >= maxS) {
      console.log(`RUNNING job=${root} elapsed=${elapsedS}s; run again: fanout wait ${root}`)
      return 4
    }
    await sleepMs(500)
  }
}

registerCommand('wait', runWait)
