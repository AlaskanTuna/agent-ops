export interface Caller {
  caller: string
  session?: string
}

export function detectCaller(env: NodeJS.ProcessEnv = process.env): Caller {
  if (env.FANOUT_CALLER) {
    const out: Caller = { caller: env.FANOUT_CALLER }
    if (env.FANOUT_SESSION) out.session = env.FANOUT_SESSION
    return out
  }
  if (env.CLAUDECODE === '1') {
    const out: Caller = { caller: 'claude-code' }
    if (env.CLAUDE_CODE_SESSION_ID) out.session = env.CLAUDE_CODE_SESSION_ID
    return out
  }
  if (env.CODEX_THREAD_ID || env.CODEX_SANDBOX || env.CODEX_CI) return { caller: 'codex' }
  if (env.GEMINI_CLI === '1') return { caller: 'gemini' }
  if (env.OPENCODE === '1') return { caller: 'opencode' }
  for (const k of Object.keys(env)) {
    if (k.startsWith('ANTIGRAVITY_')) return { caller: 'antigravity' }
  }
  for (const k of Object.keys(env)) {
    if (k.startsWith('COPILOT_')) return { caller: 'copilot' }
  }
  return { caller: 'unknown' }
}
