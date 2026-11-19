import { VERSION } from './version'
import { maybeLazyUpkeep } from './upkeep/lazy'

export type Handler = (args: string[]) => number | Promise<number>

const commands: Record<string, Handler> = {}

export function registerCommand(name: string, run: Handler): void {
  commands[name] = run
}

async function loadCommands(): Promise<void> {
  await import('./commands/pick')
  await import('./commands/run')
  await import('./commands/wait')
  await import('./commands/report')
  await import('./commands/status')
  await import('./commands/ack')
  await import('./commands/verdict')
  await import('./commands/hook')
  await import('./commands/upkeep')
  await import('./commands/benchmarks')
  await import('./commands/doctor')
  await import('./commands/incident')
}

function usage(): string {
  const names = Object.keys(commands).sort().join('|')
  return `usage: fanout <command> [options]\ncommands: ${names}`
}

async function main(): Promise<number> {
  await loadCommands()
  const argv = process.argv.slice(2)
  if (argv.length === 0) {
    console.error(usage())
    return 2
  }
  const [name, ...given] = argv
  // claude-fanout was renamed openrouter-fanout (2026-11-19): it runs OpenRouter
  // models through CLIProxyAPI, not Claude. The old name keeps working.
  let renamed = false
  const rest = given.map((a) => {
    if (a === 'claude-fanout') {
      renamed = true
      return 'openrouter-fanout'
    }
    if (a.startsWith('claude-fanout/')) {
      renamed = true
      return `openrouter-fanout/${a.slice('claude-fanout/'.length)}`
    }
    return a
  })
  if (renamed) console.error('NOTE claude-fanout was renamed openrouter-fanout; use the new name')
  if (name === '--version' || name === '-V') {
    console.log(`fanout ${VERSION}`)
    return 0
  }
  const cmd = commands[name]
  if (!cmd) {
    console.error(usage())
    return 2
  }
  if (name !== 'upkeep') await maybeLazyUpkeep()
  return await cmd(rest)
}

// No top-level await here: the bundled single-file copy wraps every module
// in a sync initializer, and the command modules import this one, so a
// top-level await deadlocks the bundle. main() is async either way.
main().then(
  (code) => process.exit(code),
  async (err) => {
    console.error(err)
    // A crash inside fanout is itself an incident: record it for the post-mortem.
    try {
      const { recordIncident } = await import('./commands/incident')
      const msg = err instanceof Error ? err.message : String(err)
      recordIncident({
        title: `fanout crashed: ${msg.slice(0, 120)}`,
        what: `argv: ${process.argv.slice(2).join(' ')}\n${err instanceof Error && err.stack ? err.stack : msg}`,
        kind: 'tooling',
        severity: 'high',
        source: 'fanout'
      })
    } catch {
      // recording never hides the original error
    }
    process.exit(1)
  }
)
