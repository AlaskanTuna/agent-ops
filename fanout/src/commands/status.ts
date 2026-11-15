import { loadCatalog } from '../catalog'
import { registerCommand } from '../cli'
import { reapStaleLeases } from '../reaper'
import { briefLines, fullLines, statusNow } from '../status'

function usage(): string {
  return 'usage: fanout status [--brief]'
}

export async function runStatus(rawArgs: string[]): Promise<number> {
  const args = [...rawArgs]
  let brief = false
  for (const a of args) {
    if (a === '--brief') brief = true
    else {
      console.error(usage())
      return 2
    }
  }
  if (!brief) {
    const { fatal } = loadCatalog()
    if (fatal) {
      console.log(fatal)
      return 3
    }
  }
  await reapStaleLeases()
  for (const line of brief ? briefLines(statusNow()) : fullLines(statusNow())) console.log(line)
  return 0
}

registerCommand('status', runStatus)
