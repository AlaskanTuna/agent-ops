import { registerCommand } from '../cli'
import { runChain, type RunOptions } from '../run'
import { registerStep, runUpkeepSteps, withUpkeepLock, writeStatusJson, readStatusJson } from '../upkeep/index'

function usage(): string {
  return 'usage: fanout upkeep [--lazy] [--only <step>]'
}

export interface UpkeepRun {
  code: number
  block: string
  root: string
}

/**
 * A `run` that reaches workers only through the no-paid path, with the
 * caller forced to `upkeep`. Smoke tests and probes call this; paid and
 * per-call rows are unreachable through it.
 */
export async function runUpkeepContext(args: string[]): Promise<UpkeepRun> {
  const o: RunOptions = { brief: '', dir: '', kind: '', noPaid: true }
  const rest = [...args]
  while (rest.length > 0) {
    const a = rest.shift()
    if (a === '--brief') o.brief = rest.shift() ?? ''
    else if (a === '--dir') o.dir = rest.shift() ?? ''
    else if (a === '--kind') o.kind = rest.shift() ?? ''
    else if (a === '--model') o.model = rest.shift() ?? ''
    else if (a === '--harness') o.harness = rest.shift() ?? ''
    else if (a === '--effort') o.effort = rest.shift() ?? ''
    else if (a === '--tier') o.startTier = Number(rest.shift() ?? '')
    else if (a === '--timeout') o.timeoutS = Number(rest.shift() ?? '')
    else if (a === '--max-turns') o.maxTurns = Number(rest.shift() ?? '')
    else if (a === '--max-attempts') o.maxAttempts = Number(rest.shift() ?? '')
    else if (a === '--pin') o.pin = true
    else if (a === '--public') o.dataClass = 'public'
    else if (a === '--private') o.dataClass = 'private'
    else if (a === '--no-paid') o.noPaid = true
    else throw new Error(`unsupported upkeep run option ${a}`)
  }
  if (!o.brief || !o.dir || !o.kind) throw new Error('upkeep run needs --brief, --dir and --kind')
  const savedCaller = process.env.FANOUT_CALLER
  process.env.FANOUT_CALLER = 'upkeep'
  try {
    const { code, block, root } = await runChain({ ...o, noPaid: true })
    return { code, block, root }
  } finally {
    if (savedCaller === undefined) delete process.env.FANOUT_CALLER
    else process.env.FANOUT_CALLER = savedCaller
  }
}

function registerTestSteps(): boolean {
  const raw = process.env.FANOUT_TEST_STEPS
  if (!raw) return false
  for (const name of raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (name === 'fail') {
      registerStep('fail', async () => {
        throw new Error('boom')
      })
    } else if (name === 'ok') {
      registerStep('ok', async () => 'ok')
    } else if (name === 'slow') {
      registerStep('slow', async () => {
        await new Promise((r) => setTimeout(r, 2000))
        return 'slow'
      })
    } else if (name === 'probe') {
      registerStep('probe', async () => {
        const brief = process.env.FANOUT_TEST_BRIEF ?? ''
        const dir = process.env.FANOUT_TEST_DIR ?? process.cwd()
        const { code, block } = await runUpkeepContext(['--brief', brief, '--dir', dir, '--kind', 'extract'])
        if (code !== 0) throw new Error(block || `probe exited ${code}`)
        return 'probe ok'
      })
    } else {
      throw new Error(`unknown test step ${name}`)
    }
  }
  return true
}

async function registerRealSteps(): Promise<void> {
  const modules: [string, string, string][] = [
    ['../upkeep/doctor', 'registerDoctorStep', 'doctor'],
    ['../upkeep/discover', 'registerDiscoverStep', 'discover'],
    ['../upkeep/smoke', 'registerSmokeStep', 'smoke'],
    ['../upkeep/patterns', 'registerPatternsStep', 'patterns'],
    ['../upkeep/housekeeping', 'registerHousekeepingStep', 'housekeeping']
  ]
  for (const [path, fn, step] of modules) {
    try {
      const mod = (await import(path)) as Record<string, (() => void) | undefined>
      mod[fn]?.()
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      registerStep(step, async () => {
        throw new Error(`step module failed to load: ${detail}`)
      })
    }
  }
}

export async function runUpkeep(rawArgs: string[]): Promise<number> {
  const args = [...rawArgs]
  let only = ''
  while (args.length > 0) {
    const a = args.shift()
    if (a === '--lazy') continue
    else if (a === '--only') only = args.shift() ?? ''
    else {
      console.error(usage())
      return 2
    }
  }
  if (!registerTestSteps()) await registerRealSteps()
  const held = await withUpkeepLock(async () =>
    runUpkeepSteps(only !== '' ? [only] : [], {
      run: runUpkeepContext,
      updateStatus: (patch) => writeStatusJson({ ...readStatusJson(), ...patch })
    })
  )
  if (!held.ran) {
    console.log('upkeep already running')
    return 0
  }
  return 0
}

registerCommand('upkeep', runUpkeep)
