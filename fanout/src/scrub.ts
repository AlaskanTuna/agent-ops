export function scrubTail(text: string, secrets: string[], brief: string): string {
  let out = text
  for (const s of secrets) {
    if (s) out = out.split(s).join('[redacted]')
  }
  out = out
    .replace(/Bearer [\w.\-~+/]+=*/g, 'Bearer [redacted]')
    .replace(/\bAIza[\w-]{30,}\b/g, '[redacted]')
    .replace(/\bsk-[\w-]{16,}\b/g, '[redacted]')
    .replace(/\b((?:api[_-]?key|token|secret|password)\s*[=:]\s*["']?)[\w.\-]{8,}/gi, '$1[redacted]')
  if (brief) out = out.split(brief).join('[brief]')
  return out.slice(-400)
}
