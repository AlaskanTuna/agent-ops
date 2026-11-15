import { registerCommand } from '../cli'
import { runDoctor, sendTestNotice } from '../upkeep/doctor'

function usage(): string {
  return 'usage: fanout doctor [--notify-test]'
}

export async function runDoctorCmd(rawArgs: string[]): Promise<number> {
  const args = [...rawArgs]
  let notifyTest = false
  for (const a of args) {
    if (a === '--notify-test') notifyTest = true
    else {
      console.error(usage())
      return 2
    }
  }
  if (notifyTest) {
    if (await sendTestNotice()) {
      console.log('PASS notify: test notification sent')
      return 0
    }
    console.log('FAIL notify: no notifier found')
    return 1
  }
  const checks = await runDoctor()
  for (const c of checks) console.log(`${c.level} ${c.name}: ${c.detail}`)
  return checks.some((c) => c.level === 'FAIL') ? 1 : 0
}

registerCommand('doctor', runDoctorCmd)
