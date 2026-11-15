import { readFileSync } from 'node:fs'
import { loadCatalog } from '../catalog'
import { nowIso } from '../clock'
import { appendEvent } from '../events'
import { newId } from '../ulid'
import { matchRowKeys, readBenchmarksDoc, writeBenchmarksDoc } from '../benchmarks'
import { registerCommand } from '../cli'

const HEADER = 'name,metric,value,as_of'
const RANGES: Record<string, [number, number]> = {
  arena_webdev: [800, 2500],
  frontiercode2: [0, 100]
}

function usage(): string {
  return 'usage: fanout benchmarks import <file>'
}

function splitLine(line: string): string[] {
  const out: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') {
        quoted = false
      } else {
        field += c
      }
    } else if (c === '"') {
      quoted = true
    } else if (c === ',') {
      out.push(field)
      field = ''
    } else {
      field += c
    }
  }
  out.push(field)
  return out.map((f) => f.trim())
}

export async function runBenchmarks(rawArgs: string[]): Promise<number> {
  const [sub, file, ...rest] = rawArgs
  if (sub !== 'import' || !file || rest.length > 0) {
    console.error(usage())
    return 2
  }
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    console.error(`cannot read file ${file}`)
    return 2
  }
  const rawLines = text.split(/\r?\n/)
  const first = rawLines.find((l) => l.trim() !== '')
  if (first?.trim() !== HEADER) {
    console.error(`header must be ${HEADER}`)
    return 2
  }
  const pastHeader = rawLines.slice(rawLines.indexOf(first) + 1)
  const data = pastHeader.filter((l) => l.trim() !== '').map(splitLine)
  const { rows, warnings, fatal } = loadCatalog()
  for (const w of warnings) console.error(w)
  if (fatal) {
    console.error(fatal)
    return 1
  }
  const today = nowIso().slice(0, 10)
  const stamped = nowIso()
  const doc = readBenchmarksDoc() ?? { values: {} }
  const values = doc.values ?? {}
  let imported = 0
  const models = new Set<string>()
  let skipped = 0
  data.forEach((fields, i) => {
    const n = i + 1
    const skip = (reason: string): void => {
      console.log(`SKIPPED row ${n}: ${reason}`)
      skipped += 1
    }
    if (fields.length !== 4) return skip(`expected 4 columns, got ${fields.length}`)
    const [name, metric, valueRaw, asOfRaw] = fields
    if (!name) return skip('name is required')
    const range = RANGES[metric]
    if (!range) return skip(`unknown metric ${metric}`)
    const value = Number(valueRaw)
    if (valueRaw === '' || !Number.isFinite(value)) return skip('value must be a number')
    if (value < range[0] || value > range[1]) return skip(`${metric} must be ${range[0]} to ${range[1]}`)
    const keys = matchRowKeys(rows, name)
    if (keys.length === 0) {
      console.log(`UNMATCHED ${name}`)
      return
    }
    const asOf = asOfRaw || today
    for (const key of keys) {
      values[key] = { ...values[key], [metric]: value }
      models.add(key)
      appendEvent({
        v: 1,
        ts: stamped,
        event: 'benchmark',
        id: newId(),
        model: key,
        source: 'import',
        metric,
        value,
        as_of: asOf
      })
    }
    imported += 1
  })
  writeBenchmarksDoc({ ...doc, values })
  console.log(`IMPORTED ${imported} values for ${models.size} models; skipped ${skipped}`)
  return imported > 0 ? 0 : 1
}

registerCommand('benchmarks', runBenchmarks)
