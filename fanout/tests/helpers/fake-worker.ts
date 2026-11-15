import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'

const scenario = process.argv[2] ?? 'ok'
const briefPath = process.argv[3] ?? ''
const sleepS = Number(process.env.FAKE_SLEEP_S ?? '3')

function sleep(s: number): Promise<void> {
  return new Promise((r) => setTimeout(r, s * 1000))
}

function usage(): void {
  process.stdout.write('USAGE in=1000 cached=0 out=200\n')
}

function writeOutputs(): void {
  writeFileSync('out.txt', 'done\n')
  writeFileSync('seen.txt', readdirSync('.').join('\n') + '\n')
}

async function main(): Promise<number> {
  switch (scenario) {
    case 'ok':
      writeOutputs()
      process.stdout.write('done\n')
      usage()
      return 0
    case 'ok_slow':
      await sleep(sleepS)
      writeOutputs()
      process.stdout.write('done\n')
      usage()
      return 0
    case 'ok_mentions_429':
      writeOutputs()
      process.stdout.write('see the 429 Too Many Requests section\n')
      usage()
      return 0
    case 'rate_limited':
      process.stderr.write('HTTP 429 Too Many Requests\n')
      return 1
    case 'rate_limited_reset':
      process.stderr.write('HTTP 429 Too Many Requests\nresets at 18:00\n')
      return 1
    case 'quota_exhausted':
      process.stderr.write('You have exhausted your quota; try again in 2 hours\n')
      return 1
    case 'credits_exhausted':
      process.stderr.write('HTTP 402 insufficient funds\n')
      return 1
    case 'auth_error':
      process.stderr.write('HTTP 401 unauthorized\n')
      return 1
    case 'model_unavailable':
      process.stderr.write('model x is not recognized\n')
      return 1
    case 'unknown_error':
      process.stderr.write('kaboom 42\n')
      return 1
    case 'job_error_ctx':
      process.stderr.write('context_length_exceeded: prompt is too long\n')
      return 1
    case 'ok_no_usage':
      writeOutputs()
      process.stdout.write('done\n')
      return 0
    case 'usage_then_sleep': {
      const pidfile = process.env.FAKE_PIDFILE
      if (pidfile) {
        try {
          appendFileSync(pidfile, `${process.pid}\n`)
        } catch {
          // pid tracking never breaks the worker
        }
      }
      process.stdout.write('USAGE in=1000 cached=0 out=200\n')
      await sleep(sleepS)
      writeOutputs()
      process.stdout.write('done\n')
      return 0
    }
    case 'ok_no_write':
      process.stdout.write('done\n')
      usage()
      return 0
    case 'worker_crash':
      process.stderr.write('worker crashed: context canceled\n')
      return 1
    case 'custom_error':
      process.stderr.write(`${process.env.FAKE_STDERR ?? ''}\n`)
      return 1
    case 'rate_limited_soon':
      process.stderr.write('HTTP 429 try again in 10 minutes\n')
      return 1
    case 'stdout_limit':
      process.stdout.write('HTTP 429 Too Many Requests\n')
      return 1
    case 'ok_hidden_failure':
      process.stdout.write('FAKE_HIDDEN_FAILURE\n')
      usage()
      return 0
    case 'timeout': {
      const pidfile = process.env.FAKE_PIDFILE
      if (pidfile) {
        const grandchild = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' })
        appendFileSync(pidfile, `${grandchild.pid}\n`)
      }
      await sleep(60)
      return 0
    }
    case 'echo_brief': {
      let brief = ''
      try {
        brief = readFileSync(briefPath, 'utf8').slice(0, 200)
      } catch {
        brief = ''
      }
      process.stderr.write(`${brief}\nkey=${process.env.FAKE_SECRET ?? ''}\n`)
      return 1
    }
    case 'print_env': {
      const out = process.env.FAKE_OUT
      if (out)
        writeFileSync(
          out,
          Object.entries(process.env)
            .map(([k, v]) => `${k}=${v}`)
            .join('\n') + '\n'
        )
      writeOutputs()
      process.stdout.write('done\n')
      usage()
      return 0
    }
    case 'nested_run': {
      const cli = process.env.FAKE_CLI ?? ''
      const brief = process.env.FAKE_BRIEF ?? ''
      const out = process.env.FAKE_OUT
      const p = Bun.spawnSync(['bun', cli, 'run', '--brief', brief, '--dir', '.', '--kind', 'transcribe'], {
        env: { ...process.env },
        stdout: 'pipe',
        stderr: 'pipe'
      })
      if (out) writeFileSync(out, p.stdout.toString())
      writeOutputs()
      process.stdout.write('done\n')
      usage()
      return 0
    }
    case 'writes_then_limit':
      writeFileSync('partial.txt', 'partial\n')
      process.stderr.write('HTTP 429 Too Many Requests\n')
      return 1
    default:
      process.stderr.write(`unknown fake scenario ${scenario}\n`)
      return 1
  }
}

const code = await main()
process.exit(code)
