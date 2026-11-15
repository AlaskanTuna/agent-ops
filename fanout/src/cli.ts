import { VERSION } from './version'

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
  return await cmd(rest)
}

const code = await main()
process.exit(code)
