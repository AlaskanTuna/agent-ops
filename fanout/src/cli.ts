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
  await import('./commands/doctor')
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
  const [name, ...rest] = argv
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
  (err) => {
    console.error(err)
    process.exit(1)
  }
)
