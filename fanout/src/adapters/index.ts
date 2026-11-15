import type { Adapter, BuildInput, BuiltCommand, Classified, RunOutput, Usage } from './types'
import { SkipCandidate } from './types'
import { CodexAdapter } from './codex'
import { AgyAdapter } from './agy'
import { FakeAdapter } from './fake'
import { MetaAdapter } from './meta'

class UnwiredAdapter implements Adapter {
  readonly name: string

  constructor(harness: string) {
    this.name = harness
  }

  build(_i: BuildInput): BuiltCommand {
    throw new SkipCandidate(`${this.name}: no adapter wired yet`)
  }

  classify(_r: RunOutput, _nowMs: number): Classified {
    return { outcome: 'unknown' }
  }

  usage(_stdout: string): Usage | undefined {
    return undefined
  }

  async listModels() {
    return []
  }

  async preflight() {
    return { ok: true } as const
  }
}

export function adapterFor(harness: string): Adapter {
  if (harness === 'fake' || harness === 'fake2' || harness === 'fake3') {
    return new FakeAdapter(harness)
  }
  if (harness === 'codex') {
    return new CodexAdapter()
  }
  if (harness === 'agy') {
    return new AgyAdapter()
  }
  if (harness === 'meta') {
    return new MetaAdapter()
  }
  return new UnwiredAdapter(harness)
}
