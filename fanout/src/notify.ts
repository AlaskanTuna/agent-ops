import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { killGroup } from './exec'
import { dataDir } from './paths'

export interface Notice {
  title: string
  body: string
}

const ACK_TAIL = '. Tell the user, then run: fanout ack '

function stripAckTail(line: string): string | undefined {
  const idx = line.indexOf(ACK_TAIL)
  if (idx < 0) return undefined
  const tail = line.slice(idx + ACK_TAIL.length)
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(tail)) return undefined
  return line.slice(0, idx)
}

/** One notification per FALLBACK or COST line of a final result block. */
export function noticesForBlock(block: string): Notice[] {
  const out: Notice[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('FALLBACK ')) {
      const body = stripAckTail(line.slice('FALLBACK '.length))
      if (body !== undefined) out.push({ title: 'fanout: fallback', body })
    } else if (line.startsWith('COST ')) {
      const rest = line.slice('COST '.length)
      const body = stripAckTail(rest)
      if (body === undefined) continue
      out.push({
        title: body.startsWith('per-call ') ? 'fanout: per-call job' : 'fanout: paid job',
        body
      })
    }
  }
  return out
}

const whichCache = new Map<string, string | null>()

function onPath(name: string): string | null {
  const hit = whichCache.get(name)
  if (hit !== undefined) return hit
  let found: string | null = null
  try {
    found = Bun.which(name)
  } catch {
    found = null
  }
  whichCache.set(name, found)
  return found
}

function runCmd(argv0: string, args: string[], extraEnv?: Record<string, string>): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let child
    try {
      child = spawn(argv0, args, {
        env: { ...process.env, ...extraEnv },
        detached: process.platform !== 'win32',
        stdio: 'ignore'
      })
    } catch (err) {
      reject(err)
      return
    }
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try {
        if (child.pid) killGroup(child.pid, 'SIGTERM')
      } catch {
        // already gone
      }
      const killTimer = setTimeout(() => {
        try {
          if (child.pid) killGroup(child.pid, 'SIGKILL')
        } catch {
          // already gone
        }
      }, 1000)
      if (killTimer.unref) killTimer.unref()
      reject(new Error('notify timed out after 3s'))
    }, 3000)
    if (timer.unref) timer.unref()
    child.on('error', (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (code === 0) resolvePromise()
      else reject(new Error(`notify exited ${code}`))
    })
  })
}

// Built into Windows 10+: needs no PowerShell module (BurntToast is not installed by default).
export const TOAST_SCRIPT =
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; $t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); $x = $t.GetElementsByTagName('text'); $x.Item(0).AppendChild($t.CreateTextNode($env:FANOUT_TOAST_TITLE)) > $null; $x.Item(1).AppendChild($t.CreateTextNode($env:FANOUT_TOAST_BODY)) > $null; [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($t))"

async function sendNotice(n: Notice): Promise<void> {
  const override = process.env.FANOUT_NOTIFY_CMD
  if (override) {
    await runCmd(override, [n.title, n.body])
    return
  }
  if (onPath('notify-send') !== null) {
    await runCmd('notify-send', [n.title, n.body])
    return
  }
  const powershell = onPath('powershell.exe')
  if (powershell !== null) {
    // Best effort and detached: a Windows-interop spawn costs a second or
    // more, and a toast must never slow a run. Failures here are not logged;
    // the FANOUT_NOTIFY_CMD and notify-send paths above stay awaited and
    // logged. Toast support on a given install is verified at go-live.
    try {
      const wsl = process.env.WSLENV
      const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', TOAST_SCRIPT], {
        env: {
          ...process.env,
          FANOUT_TOAST_TITLE: n.title,
          FANOUT_TOAST_BODY: n.body,
          WSLENV: `${wsl ? `${wsl}:` : ''}FANOUT_TOAST_TITLE:FANOUT_TOAST_BODY`
        },
        detached: process.platform !== 'win32',
        stdio: 'ignore'
      })
      child.on('error', () => {})
      if (child.unref) child.unref()
    } catch {
      // notification failures never break a run
    }
    return
  }
  // No notifier is silent.
}

function logNotifyFailed(reason: unknown): void {
  try {
    mkdirSync(dataDir(), { recursive: true, mode: 0o700 })
    appendFileSync(join(dataDir(), 'errors.log'), `${new Date().toISOString()} notify failed: ${String(reason)}\n`)
  } catch {
    // notification failures never break a run
  }
}

/** Send every FALLBACK and COST line as a desktop notification. Never throws. */
export async function notifyBlock(block: string): Promise<void> {
  for (const n of noticesForBlock(block)) {
    try {
      await sendNotice(n)
    } catch (err) {
      logNotifyFailed(err instanceof Error ? err.message : err)
    }
  }
}

function notifiedMarker(root: string): string {
  return join(dataDir(), 'logs', `${root}.notified`)
}

/**
 * Notify once per final chain. `wait` never calls this, and a block that is
 * printed again is not notified again. The marker is written only when the
 * block actually carried a notification, so a detached parent's JOB block
 * cannot suppress its chain's final notifications.
 */
export async function notifyOnce(root: string, block: string): Promise<void> {
  if (existsSync(notifiedMarker(root))) return
  const notices = noticesForBlock(block)
  if (notices.length === 0) return
  await notifyBlock(block)
  try {
    mkdirSync(join(dataDir(), 'logs'), { recursive: true, mode: 0o700 })
    writeFileSync(notifiedMarker(root), `${new Date().toISOString()}\n`, { mode: 0o600 })
  } catch {
    // marker failures mean a possible repeat, never a broken run
  }
}
