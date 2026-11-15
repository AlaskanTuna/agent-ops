import { TOAST_SCRIPT } from '../notify'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { adapterFor } from '../adapters/index'
import { homeDir } from '../paths'
import { loadCatalog } from '../catalog'
import { LEDGER_WINDOW_MS, nowIso, nowMs } from '../clock'
import { appendEvent, readEvents } from '../events'
import { detectCaller } from '../caller'
import { readState } from '../state'
import { newId } from '../ulid'
import { registerStep } from './index'

export interface Check {
  name: string
  level: 'PASS' | 'WARN' | 'FAIL'
  detail: string
}

function home(): string {
  return process.env.HOME ?? homeDir()
}

function short(path: string): string {
  const h = home()
  return path === h ? '~' : path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path
}

function checkDataDir(): Check {
  const primary = process.env.FANOUT_HOME ?? join(home(), '.local', 'share', 'agent-ops', 'fanout')
  try {
    mkdirSync(primary, { recursive: true, mode: 0o700 })
    const probe = join(primary, `.writetest-${process.pid}`)
    writeFileSync(probe, '1', { mode: 0o600 })
    const back = readFileSync(probe, 'utf8')
    unlinkSync(probe)
    if (back !== '1') return { name: 'data-dir', level: 'FAIL', detail: 'round trip mismatch' }
    return { name: 'data-dir', level: 'PASS', detail: 'writable and an append round trip works' }
  } catch (err) {
    return { name: 'data-dir', level: 'FAIL', detail: err instanceof Error ? err.message : String(err) }
  }
}

function coolAccountOnce(harness: string, outcome: string): void {
  try {
    const state = readState(nowMs())
    if (state.cooldowns.has(`${harness}/*`)) return
    const { caller, session } = detectCaller()
    appendEvent({
      v: 1,
      ts: nowIso(),
      event: 'limit_hit',
      id: newId(),
      harness,
      model: '*',
      scope: 'account',
      outcome,
      source: 'backoff',
      until: new Date(nowMs() + 15 * 60 * 1000).toISOString(),
      caller,
      ...(session !== undefined ? { session } : {})
    })
  } catch {
    // cooling never breaks the doctor
  }
}

async function checkAdapters(): Promise<Check[]> {
  const { rows, fatal } = loadCatalog()
  if (fatal) return [{ name: 'adapter', level: 'FAIL', detail: fatal }]
  const harnesses = [...new Set(rows.map((r) => r.harness))].sort()
  const out: Check[] = []
  for (const h of harnesses) {
    let preflight: Awaited<ReturnType<ReturnType<typeof adapterFor>['preflight']>>
    try {
      preflight = await adapterFor(h).preflight()
    } catch (err) {
      preflight = { ok: false, outcome: 'worker_error', detail: err instanceof Error ? err.message : String(err) }
    }
    if (preflight.ok) {
      out.push({ name: `adapter-${h}`, level: 'PASS', detail: 'preflight ok' })
    } else {
      out.push({ name: `adapter-${h}`, level: 'WARN', detail: `${preflight.outcome} ${preflight.detail}` })
      if (preflight.outcome === 'auth_error') coolAccountOnce(h, preflight.outcome)
    }
  }
  return out
}

function checkDuckdb(): Check {
  try {
    const p = Bun.spawnSync(['duckdb', '--version'], { stdout: 'ignore', stderr: 'ignore' })
    if (p.exitCode === 0) return { name: 'duckdb', level: 'PASS', detail: 'duckdb --version exits 0' }
  } catch {
    // fall through to the warning
  }
  return { name: 'duckdb', level: 'WARN', detail: 'duckdb not found on PATH' }
}

function checkPath(): Check {
  try {
    const p = Bun.spawnSync(['env', '-i', `HOME=${home()}`, 'bash', '-lc', 'command -v fanout'], {
      stdout: 'pipe',
      stderr: 'ignore'
    })
    const found = p.exitCode === 0 ? p.stdout.toString().trim() : ''
    if (found !== '')
      return { name: 'path', level: 'PASS', detail: `fanout resolves to ${found} via the login profile` }
  } catch {
    // fall through to the warning
  }
  return { name: 'path', level: 'WARN', detail: 'fanout not found via the login profile' }
}

function checkSkill(): Check {
  const dirs = [
    join(home(), '.claude', 'skills'),
    join(home(), '.agents', 'skills'),
    join(home(), '.gemini', 'config', 'skills')
  ]
  const missing = dirs.filter((d) => !existsSync(join(d, 'fanout')))
  if (missing.length === 0) return { name: 'skill', level: 'PASS', detail: 'fanout skill reachable in 3 folders' }
  return { name: 'skill', level: 'WARN', detail: `missing ${missing.map((m) => short(m)).join(', ')}` }
}

function checkHooks(): Check {
  try {
    const raw = readFileSync(join(home(), '.claude', 'settings.json'), 'utf8')
    const parsed = JSON.parse(raw) as { hooks?: Record<string, unknown> }
    const hooks = parsed.hooks ?? {}
    const stop = JSON.stringify(hooks.Stop ?? null).includes('fanout-stop-hook')
    const start = JSON.stringify(hooks.SessionStart ?? null).includes('fanout-session-hook')
    const missing: string[] = []
    if (!stop) missing.push('Stop group naming fanout-stop-hook')
    if (!start) missing.push('SessionStart group naming fanout-session-hook')
    if (missing.length === 0) return { name: 'hooks', level: 'PASS', detail: 'stop and session-start groups present' }
    return { name: 'hooks', level: 'WARN', detail: `missing ${missing.join(', ')}` }
  } catch {
    return { name: 'hooks', level: 'WARN', detail: 'settings.json has no fanout hook groups' }
  }
}

function checkTimer(): Check {
  try {
    const p = Bun.spawnSync(['systemctl', '--user', 'is-enabled', 'fanout-upkeep.timer'], {
      stdout: 'pipe',
      stderr: 'ignore'
    })
    if (p.exitCode === 0 && p.stdout.toString().trim() === 'enabled') {
      return { name: 'timer', level: 'PASS', detail: 'fanout-upkeep.timer is enabled' }
    }
  } catch {
    // fall through to the warning
  }
  return { name: 'timer', level: 'WARN', detail: 'fanout-upkeep.timer is not enabled' }
}

function notifierKind(): 'cmd' | 'notify-send' | 'powershell' | undefined {
  if (process.env.FANOUT_NOTIFY_CMD) return 'cmd'
  try {
    if (Bun.which('notify-send') !== null) return 'notify-send'
  } catch {
    // no notifier
  }
  try {
    if (Bun.which('powershell.exe') !== null) return 'powershell'
  } catch {
    // no notifier
  }
  return undefined
}

function checkNotify(): Check {
  const kind = notifierKind()
  if (kind === 'cmd') return { name: 'notify', level: 'PASS', detail: 'FANOUT_NOTIFY_CMD is set' }
  if (kind === 'notify-send') return { name: 'notify', level: 'PASS', detail: 'notify-send is on PATH' }
  if (kind === 'powershell') return { name: 'notify', level: 'PASS', detail: 'powershell.exe is on PATH' }
  return { name: 'notify', level: 'WARN', detail: 'no notifier found' }
}

function readSecretsFile(file: string): Map<string, string> {
  const out = new Map<string, string>()
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return out
  }
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    let v = m[2]
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1)
    }
    out.set(m[1], v)
  }
  return out
}

function checkAaKey(): Check {
  const file = process.env.FANOUT_SECRETS ?? join(home(), '.config', 'tolong', 'secrets.env')
  const keys = readSecretsFile(file)
  const value = keys.get('AA_API_KEY')
  if (value !== undefined && value !== '') return { name: 'aa-key', level: 'PASS', detail: 'AA_API_KEY is set' }
  return { name: 'aa-key', level: 'WARN', detail: `AA_API_KEY is not set in ${short(file)}` }
}

function checkLearned(): Check {
  const dir = join(process.env.FANOUT_HOME ?? '', 'learned')
  const jsonFiles = ['catalog.auto.json', 'patterns.json', 'benchmarks.json']
  for (const f of jsonFiles) {
    const path = join(dir, f)
    if (!existsSync(path)) continue
    try {
      JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return { name: 'learned', level: 'WARN', detail: `${f} is not valid JSON` }
    }
  }
  const statePath = join(dir, 'state.jsonl')
  if (existsSync(statePath)) {
    for (const line of readFileSync(statePath, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        JSON.parse(line)
      } catch {
        return { name: 'learned', level: 'WARN', detail: 'state.jsonl has a corrupt line' }
      }
    }
  }
  return { name: 'learned', level: 'PASS', detail: 'learned files parse' }
}

function checkLedger(): Check {
  let skipped = 0
  try {
    const eventsDir = join(process.env.FANOUT_HOME ?? '', 'events')
    if (!existsSync(eventsDir)) return { name: 'ledger', level: 'PASS', detail: '0 future-version events skipped' }
    for (const f of readdirSync(eventsDir)) {
      if (!f.endsWith('.jsonl')) continue
      for (const line of readFileSync(join(eventsDir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const e = JSON.parse(line) as { v?: unknown }
          if (typeof e.v === 'number' && e.v > 1) skipped += 1
        } catch {
          // corrupt lines are skipped by readers too
        }
      }
    }
  } catch {
    // an unreadable ledger never fails the doctor
  }
  return { name: 'ledger', level: 'PASS', detail: `${skipped} future-version events skipped` }
}

export async function runDoctor(): Promise<Check[]> {
  const checks: Check[] = [
    checkDataDir(),
    ...(await checkAdapters()),
    checkDuckdb(),
    checkPath(),
    checkSkill(),
    checkHooks(),
    checkTimer(),
    checkNotify(),
    checkAaKey(),
    checkLearned(),
    checkLedger()
  ]
  return checks
}

/** Send one test notification. False when no notifier exists. */
export async function sendTestNotice(): Promise<boolean> {
  const kind = notifierKind()
  if (kind === undefined) return false
  const title = 'fanout: test'
  const body = 'notifications work'
  try {
    if (kind === 'cmd') {
      const p = Bun.spawnSync([process.env.FANOUT_NOTIFY_CMD as string, title, body], {
        stdout: 'ignore',
        stderr: 'ignore'
      })
      return p.exitCode === 0
    }
    if (kind === 'notify-send') {
      const p = Bun.spawnSync(['notify-send', title, body], { stdout: 'ignore', stderr: 'ignore' })
      return p.exitCode === 0
    }
    const p = Bun.spawnSync(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', TOAST_SCRIPT], {
      stdout: 'ignore',
      stderr: 'ignore',
      env: {
        ...process.env,
        FANOUT_TOAST_TITLE: title,
        FANOUT_TOAST_BODY: body,
        // WSL passes only the variables WSLENV names to a Windows process
        WSLENV: `${process.env.WSLENV ? `${process.env.WSLENV}:` : ''}FANOUT_TOAST_TITLE:FANOUT_TOAST_BODY`
      }
    })
    return p.exitCode === 0
  } catch {
    return false
  }
}

export function registerDoctorStep(): void {
  registerStep('doctor', async () => {
    const checks = await runDoctor()
    const fails = checks.filter((c) => c.level === 'FAIL')
    const warns = checks.filter((c) => c.level === 'WARN')
    if (fails.length > 0) throw new Error(`${fails.length} failing: ${fails.map((c) => c.name).join(', ')}`)
    return `${checks.length - warns.length} pass, ${warns.length} warn`
  })
}
