const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g
const PREFIXED_ID_RE = /\b(?:toolu|req|org|sess)[-_][\w-]+\b/g
const ULID_RE = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g
const WIN_PATH_RE = /[A-Za-z]:[\\/][^\s'"]*/g
const HOME_PATH_RE = /~\/[^\s'"]*/g
const ABS_PATH_RE = /~?(?:\/[A-Za-z0-9._~@-]+)+/g

// Scrub a transcript excerpt for use as a committed fixture: ids, paths,
// emails, keys, secrets and IPs become placeholders. No input survives verbatim.
export function scrubFixture(text: string): string {
  let out = text
  out = out.replace(/(https?:\/\/[^\s'"]*?)\?[^\s'"]*/g, '$1')
  out = out.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>')
  out = out
    .replace(/Bearer [\w.\-~+/]+=*/g, '<secret>')
    .replace(/\bAIza[\w-]{30,}\b/g, '<secret>')
    .replace(/\bsk-[\w-]{16,}\b/g, '<secret>')
    .replace(/\bghp_[\w-]{16,}/g, '<secret>')
    .replace(/\bxox[\w-]{16,}/g, '<secret>')
    .replace(/\b((?:api[_-]?key|token|secret|password)\s*[=:]\s*["']?)[\w.\-]{8,}/gi, '$1<secret>')
  out = out.replace(UUID_RE, '<id>').replace(PREFIXED_ID_RE, '<id>').replace(ULID_RE, '<id>')
  out = out.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '<ip>')
  out = out.replace(WIN_PATH_RE, '<path>').replace(HOME_PATH_RE, '<path>').replace(ABS_PATH_RE, '<path>')
  out = out.replace(/\b[0-9a-fA-F]{12,}\b/g, '<id>').replace(/\b[\w-]{24,}\b/g, '<id>')
  return out
}

const PLACEHOLDER_RE = /^(<(id|path|email|secret|ip|n|hex)>)$/

// Reduce a scrubbed line to a cluster signature: numbers become <n>, remaining
// hex runs <hex>, leftover ids and paths their placeholders. Placeholders pass through.
export function normalizeSignature(line: string): string {
  const parts = line.split(/(<(?:id|path|email|secret|ip|n|hex)>)/g)
  const norm = parts.map((p) => {
    if (PLACEHOLDER_RE.test(p)) return p
    return p
      .replace(UUID_RE, '<id>')
      .replace(PREFIXED_ID_RE, '<id>')
      .replace(ULID_RE, '<id>')
      .replace(WIN_PATH_RE, '<path>')
      .replace(HOME_PATH_RE, '<path>')
      .replace(ABS_PATH_RE, '<path>')
      .replace(/\b[0-9a-fA-F]{8,}\b/g, '<hex>')
      .replace(/\d+/g, '<n>')
  })
  return norm.join('').replace(/\s+/g, ' ').trim().toLowerCase()
}

const TOKEN_CLASS: Record<string, string> = {
  '<id>': '[A-Za-z0-9_.-]+',
  '<path>': '\\S+',
  '<email>': '\\S+',
  '<secret>': '\\S+',
  '<ip>': '\\d+(?:\\.\\d+){3}',
  '<n>': '\\d[\\d:.,]*',
  '<hex>': '[0-9a-fA-F]+'
}

// Turn a signature into a matcher for adapter pattern files: placeholders become
// character classes, everything else is escaped literally.
export function signatureToRegex(sig: string): string {
  return sig
    .split(/(<[a-z]+>)/g)
    .map((p) => TOKEN_CLASS[p] ?? p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('')
}

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
