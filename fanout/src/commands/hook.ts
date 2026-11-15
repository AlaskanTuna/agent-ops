import { nowMs } from '../clock'
import { registerCommand } from '../cli'
import { chains } from '../state'
import { briefLines, unreportedSummary } from '../status'

const THREE_DAYS_MS = 3 * 24 * 3600 * 1000

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    try {
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (chunk: string) => {
        data += chunk
      })
      process.stdin.on('end', () => resolve(data))
      process.stdin.on('error', () => resolve(''))
    } catch {
      resolve('')
    }
  })
}

async function hookStop(): Promise<number> {
  let payload: { session_id?: unknown; stop_hook_active?: unknown }
  try {
    payload = JSON.parse(await readStdin()) as { session_id?: unknown; stop_hook_active?: unknown }
  } catch {
    return 0
  }
  if (payload.stop_hook_active === true) return 0
  if (typeof payload.session_id !== 'string' || payload.session_id === '') return 0
  const now = nowMs()
  const cutoff = now - THREE_DAYS_MS
  const lines: string[] = []
  for (const chain of chains(now)) {
    if (!chain.finished || chain.reported || chain.caller === 'upkeep') continue
    if (chain.session !== payload.session_id) continue
    if (Number.isNaN(Date.parse(chain.firstTs)) || Date.parse(chain.firstTs) < cutoff) continue
    if (chain.hops.length === 0 && !chain.rerouted && chain.paidJobs.length === 0) continue
    lines.push(`${unreportedSummary(chain)} -> fanout ack ${chain.finalJob}`)
  }
  if (lines.length === 0) return 0
  console.log(
    JSON.stringify({
      decision: 'block',
      reason: `Fanout: tell the user about these before stopping, then run the ack command: ${lines.join('\n')}`
    })
  )
  return 0
}

async function hookSessionStart(): Promise<number> {
  try {
    await readStdin()
  } catch {
    return 0
  }
  const lines = briefLines(nowMs())
  if (lines.length === 1 && lines[0] === 'fanout: ok') return 0
  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') }
    })
  )
  return 0
}

export async function runHook(rawArgs: string[]): Promise<number> {
  try {
    const [sub] = rawArgs
    if (sub === 'stop') return await hookStop()
    if (sub === 'session-start') return await hookSessionStart()
    return 0
  } catch {
    // Hooks fail open: any exception exits 0 silently.
    return 0
  }
}

registerCommand('hook', runHook)
