export type Outcome =
  | 'ok'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'credits_exhausted'
  | 'auth_error'
  | 'model_unavailable'
  | 'timeout'
  | 'worker_error'
  | 'job_error'
  | 'no_effect'
  | 'unknown'

export type Billing = 'subscription' | 'free' | 'paid' | 'per_call'

export interface BuildInput {
  model: string
  effort?: string
  cwd: string
  briefPath: string
  job: string
  outDir: string
  timeoutS: number
  maxTurns: number
  bypass: boolean
  allow: string[]
}

export interface BuiltCommand {
  argv: string[]
  cwd: string
  env: Record<string, string | null>
  stdinPath?: string
  stdinText?: string
  secrets: string[]
  reportPath?: string
}

export interface RunOutput {
  exit: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface Classified {
  outcome: Outcome
  scope?: 'model' | 'account'
  until?: number
  cooldownS?: number
  pattern?: string
  match?: string
}

export interface Usage {
  tokensIn: number
  tokensOut: number
  tokensCached: number
  /** USD the harness itself priced for the job (cache writes included), when it reports one. */
  costUsd?: number
}

export interface ModelInfo {
  model: string
  efforts?: string[]
  billing?: Billing
  priceIn?: number
  priceCached?: number
  priceOut?: number
  priceCall?: number
  dataClass?: 'any' | 'public-only'
}

export type Preflight = { ok: true } | { ok: false; outcome: Outcome; detail: string }

export class SkipCandidate extends Error {
  constructor(
    public reason: string,
    public outcome: Outcome = 'model_unavailable'
  ) {
    super(reason)
  }
}

export interface Adapter {
  name: string
  defaults?: { timeoutS?: number; maxTurns?: number }
  envAllow?: string[]
  build(i: BuildInput): BuiltCommand
  classify(r: RunOutput, nowMs: number): Classified
  usage(stdout: string): Usage | undefined
  listModels(): Promise<ModelInfo[]>
  preflight(o?: { quick?: boolean }): Promise<Preflight>
  upstream?(model: string): string | undefined
  proxyBacked?: boolean
  measure?(w: {
    startMs: number
    endMs: number
    route: string
    overlapped: boolean
  }): Promise<{ calls: number } | 'unmeasured'>
  probe?(): Promise<{ remainingPct?: number; resetsAt?: number } | undefined>
}
