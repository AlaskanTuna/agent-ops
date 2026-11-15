import {
  accessSync,
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { X_OK } from 'node:constants'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export interface StartedProcess {
  pid: number
  stdoutSoFar(): string
  stderrSoFar(): string
  done(): Promise<RunResult>
}

export interface FanoutOptions {
  noCatalog?: boolean
  env?: Record<string, string | undefined>
  cwd?: string
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function newSandboxId(): string {
  const bytes = new Uint8Array(26)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => CROCKFORD[b % 32]).join('')
}

function cliPath(): string {
  return resolve(import.meta.dir, '../../src/cli.ts')
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'fanout-repo-'))
  const run = (args: string[], extra?: Record<string, string>) => {
    const p = Bun.spawnSync(['git', ...args], {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...extra }
    })
    if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${p.stderr.toString()}`)
  }
  run(['init', '-q'])
  run(['config', 'user.email', 'test@example.invalid'])
  run(['config', 'user.name', 'fanout-test'])
  writeFileSync(join(repo, 'a.txt'), 'hello\n')
  run(['add', 'a.txt'])
  run(['commit', '-qm', 'initial'])
  return repo
}

export function waitFor(pred: () => boolean, timeoutMs = 10000): Promise<void> {
  const start = Date.now()
  return new Promise((resolvePromise, reject) => {
    const tick = () => {
      let ok = false
      try {
        ok = pred()
      } catch {
        ok = false
      }
      if (ok) return resolvePromise()
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'))
      setTimeout(tick, 50)
    }
    tick()
  })
}

export class Sandbox {
  readonly home: string
  readonly repo: string
  readonly env: Record<string, string>
  private briefCount = 0
  private catalogFile: string

  constructor() {
    this.home = mkdtempSync(join(tmpdir(), 'fanout-home-'))
    this.repo = initRepo()
    mkdirSync(join(this.home, 'bin'), { recursive: true })
    this.catalogFile = join(this.home, 'catalog.csv')
    const fixture = resolve(import.meta.dir, '../fixtures/catalog.fake.csv')
    if (existsSync(fixture)) writeFileSync(this.catalogFile, readFileSync(fixture, 'utf8'))
    else writeFileSync(this.catalogFile, 'harness,model\n')
    this.env = {
      ...(process.env as Record<string, string>),
      HOME: this.home,
      FANOUT_HOME: this.home,
      FANOUT_FAKE: '1',
      FANOUT_NO_LAZY: '1',
      // never pop a real desktop toast from a test; notify tests set their own stub
      FANOUT_NOTIFY_CMD: 'true',
      FANOUT_NO_SLEEP: '1',
      FANOUT_CALLER: 'test',
      FANOUT_SESSION: 'S1',
      TZ: 'Asia/Kuala_Lumpur',
      FANOUT_CATALOG_FILE: this.catalogFile,
      PATH: join(this.home, 'bin') + ':' + (process.env.PATH ?? '')
    }
  }

  at(iso: string): this {
    this.env.FANOUT_NOW = iso
    return this
  }

  brief(text = 'Rename foo in a.txt to bar, nothing else', bytes?: number): string {
    let content = text
    if (bytes !== undefined) {
      const buf = Buffer.from(content, 'utf8')
      if (buf.length > bytes) content = buf.subarray(0, bytes).toString('utf8')
      else if (buf.length < bytes) content += 'x'.repeat(bytes - buf.length)
    }
    this.briefCount += 1
    const p = join(this.home, `brief-${this.briefCount}.txt`)
    writeFileSync(p, content)
    return p
  }

  catalog(csv: string): this {
    writeFileSync(this.catalogFile, csv)
    return this
  }

  fixtureCatalog(): string {
    return readFileSync(resolve(import.meta.dir, '../fixtures/catalog.fake.csv'), 'utf8')
  }

  catalogPrivate(csv: string): this {
    const dir = join(this.home, '.config', 'agent-ops')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'catalog.csv'), csv)
    return this
  }

  script(map: Record<string, string[]>): this {
    const p = join(this.home, 'fake-script.json')
    writeFileSync(p, JSON.stringify(map))
    this.env.FANOUT_FAKE_SCRIPT = p
    const countersFile = join(this.home, 'fake-counters.json')
    if (existsSync(countersFile)) {
      try {
        const counters = JSON.parse(readFileSync(countersFile, 'utf8')) as Record<string, number>
        for (const k of Object.keys(map)) delete counters[k]
        writeFileSync(countersFile, JSON.stringify(counters))
      } catch {
        // corrupt counters are ignored and rebuilt by the fake adapter
      }
    }
    return this
  }

  bin(name: string, body: string): string {
    const p = join(this.home, 'bin', name)
    writeFileSync(p, body)
    chmodSync(p, 0o755)
    return p
  }

  pathWithout(names: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'fanout-path-'))
    const seen = new Set<string>()
    for (const d of (process.env.PATH ?? '').split(':')) {
      if (!d) continue
      let entries: string[] = []
      try {
        entries = readdirSync(d)
      } catch {
        continue
      }
      for (const e of entries) {
        if (names.includes(e) || seen.has(e)) continue
        const src = join(d, e)
        try {
          if (!statSync(src).isFile()) continue
          accessSync(src, X_OK)
          symlinkSync(src, join(dir, e))
          seen.add(e)
        } catch {
          // not a linkable executable; skip
        }
      }
    }
    return dir
  }

  async fanout(args: string[], opts: FanoutOptions = {}): Promise<RunResult> {
    const proc = Bun.spawn(['bun', cliPath(), ...args], {
      cwd: opts.cwd ?? this.repo,
      env: this.buildEnv(opts),
      stdout: 'pipe',
      stderr: 'pipe'
    })
    await proc.exited
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    return { code: proc.exitCode ?? 1, stdout, stderr }
  }

  start(args: string[], opts: FanoutOptions = {}): StartedProcess {
    const proc = Bun.spawn(['bun', cliPath(), ...args], {
      cwd: opts.cwd ?? this.repo,
      env: this.buildEnv(opts),
      stdout: 'pipe',
      stderr: 'pipe'
    })
    let out = ''
    let err = ''
    let finished = false
    let code = 1
    const pump = async (stream: ReadableStream<Uint8Array> | null, append: (s: string) => void) => {
      if (!stream) return
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        append(decoder.decode(value, { stream: true }))
      }
      append(decoder.decode())
    }
    const outP = pump(proc.stdout as ReadableStream<Uint8Array>, (s) => {
      out += s
    })
    const errP = pump(proc.stderr as ReadableStream<Uint8Array>, (s) => {
      err += s
    })
    const done = async (): Promise<RunResult> => {
      code = await proc.exited
      await Promise.all([outP, errP])
      finished = true
      return { code, stdout: out, stderr: err }
    }
    void finished
    return {
      pid: proc.pid,
      stdoutSoFar: () => out,
      stderrSoFar: () => err,
      done
    }
  }

  seed(events: Record<string, unknown>[]): this {
    for (const e of events) {
      const event = { v: 1, id: newSandboxId(), ...e } as Record<string, unknown>
      const month = String(event.ts).slice(0, 7)
      const dir = join(this.home, 'events')
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, `${month}.jsonl`), JSON.stringify(event) + '\n')
    }
    return this
  }

  seedLearned(file: string, lines: unknown[]): this {
    const p = join(this.home, 'learned', file)
    mkdirSync(join(this.home, 'learned'), { recursive: true })
    writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n')
    return this
  }

  ledger(): Record<string, unknown>[] {
    const dir = join(this.home, 'events')
    if (!existsSync(dir)) return []
    const out: Record<string, unknown>[] = []
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith('.jsonl')) continue
      for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          out.push(JSON.parse(line) as Record<string, unknown>)
        } catch {
          // corrupt lines are skipped
        }
      }
    }
    out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || String(a.id).localeCompare(String(b.id)))
    return out
  }

  learned(file: string): Record<string, unknown>[] {
    const p = join(this.home, 'learned', file)
    if (!existsSync(p)) return []
    const out: Record<string, unknown>[] = []
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as Record<string, unknown>)
      } catch {
        // corrupt lines are skipped
      }
    }
    return out
  }

  private buildEnv(opts: FanoutOptions): Record<string, string> {
    const env: Record<string, string | undefined> = { ...this.env, ...opts.env }
    if (opts.noCatalog) delete env.FANOUT_CATALOG_FILE
    const clean: Record<string, string> = {}
    for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v
    return clean
  }
}

export function sandbox(): Sandbox {
  return new Sandbox()
}
