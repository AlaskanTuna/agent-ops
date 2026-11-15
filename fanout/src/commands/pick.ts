import { existsSync, statSync } from 'node:fs'
import { kindInfo, loadCatalog } from '../catalog'
import { adapterFor } from '../adapters/index'
import { chunkClass, rowClass, upstreamClass } from '../dataclass'
import { estimate, formatUsd } from '../cost'
import { candidates, resolveModel } from '../pick'
import { reapStaleLeases } from '../reaper'
import { registerCommand } from '../cli'

function usage(): string {
  return 'usage: fanout pick --brief <file> --dir <dir> --kind <kind> [--harness <h>] [--tier <n>] [--all] [--public|--private] [--max-turns <n>]'
}

export async function runPick(rawArgs: string[]): Promise<number> {
  let brief = ''
  let dir = process.cwd()
  let kind = ''
  let harness: string | undefined
  let tier: number | undefined
  let all = false
  let maxTurns = 8
  let model: string | undefined
  const args = [...rawArgs]
  while (args.length > 0) {
    const a = args.shift()
    if (a === '--brief') brief = args.shift() ?? ''
    else if (a === '--dir') dir = args.shift() ?? dir
    else if (a === '--kind') kind = args.shift() ?? ''
    else if (a === '--harness') harness = args.shift() ?? ''
    else if (a === '--model') model = args.shift() ?? ''
    else if (a === '--tier') {
      const t = Number(args.shift() ?? '')
      if (t !== 1 && t !== 2 && t !== 3) {
        console.error('usage: fanout pick --tier must be 1, 2 or 3')
        return 2
      }
      tier = t
    } else if (a === '--all') all = true
    else if (a === '--public' || a === '--private' || a === '--no-paid') continue
    else if (a === '--max-turns') maxTurns = Number(args.shift() ?? '')
    else {
      console.error(usage())
      return 2
    }
  }
  const sawPublic = rawArgs.includes('--public')
  const sawPrivate = rawArgs.includes('--private')
  if (sawPublic && sawPrivate) {
    console.error('--public and --private conflict')
    return 2
  }
  if (!brief || !kind) {
    console.error(usage())
    return 2
  }
  if (!existsSync(brief)) {
    console.error(`cannot read brief ${brief}`)
    return 2
  }
  const briefBytes = statSync(brief).size
  const { rows, warnings, fatal } = loadCatalog()
  if (fatal) {
    console.log(fatal)
    return 3
  }
  for (const w of warnings) console.error(w)
  await reapStaleLeases()
  const upstreamOf = (row: { harness: string; model: string }) => adapterFor(row.harness).upstream?.(row.model)
  const actualClass = sawPublic ? 'public' : sawPrivate ? 'private' : chunkClass(dir)
  const noPaid = rawArgs.includes('--no-paid')
  if (model) {
    const resolved = resolveModel(rows, model, harness)
    if (!resolved) {
      console.error(`unknown model ${model}`)
      return 2
    }
    if (actualClass === 'private' && rowClass(resolved, adapterFor(resolved.harness)) === 'public-only') {
      console.log(`REFUSED ${resolved.harness}/${resolved.model} is public-only and this chunk is private`)
      return 3
    }
  }
  const list = candidates(rows, {
    kind,
    startTier: tier,
    harness,
    briefBytes,
    dataClass: actualClass,
    noPaid,
    upstreamOf
  })
  if (model) {
    const resolved = resolveModel(rows, model, harness)
    if (resolved) {
      const idx = list.findIndex((c) => c.row.harness === resolved.harness && c.row.model === resolved.model)
      if (idx >= 0) list.splice(idx, 1)
      list.unshift({ row: resolved, effort: resolved.efforts[0] ?? '' })
    }
  }
  if (list.length === 0) {
    if (actualClass === 'private') {
      const startTier = tier ?? kindInfo(kind).tier
      const pubOnly = rows.filter((r) => {
        if (r.status !== 'active') return false
        if (r.tier < startTier) return false
        if (briefBytes < r.minBriefBytes) return false
        if (r.dataClass !== 'public-only' && upstreamClass(upstreamOf(r)) !== 'public-only') return false
        return true
      }).length
      if (pubOnly > 0) {
        console.log(`REFUSED no eligible candidate (private chunk; public-only rows skipped: ${pubOnly})`)
        return 3
      }
    }
    console.log('REFUSED no eligible candidate')
    return 3
  }
  const [first, ...rest] = list
  console.log(
    `PICK harness=${first.row.harness} model=${first.row.model} tier=${first.row.tier} billing=${first.row.billing} effort=${first.effort} data=${actualClass}`
  )
  console.log(
    `THEN ${rest
      .slice(0, 3)
      .map((c) => `${c.row.harness}/${c.row.model}`)
      .join(', ')}`
  )
  const paid = list.find((c) => c.row.billing === 'paid' || c.row.billing === 'per_call')
  if (!paid) {
    console.log('PAID none (no paid or per-call model in the chain)')
  } else {
    const est = estimate(paid.row, kind, { maxTurns })
    if (paid.row.billing === 'per_call' && est?.mc !== undefined) {
      console.log(
        `PAID ${paid.row.harness}/${paid.row.model} ESTIMATE ${est.mc} MC (${est.calls} turns x ${paid.row.priceCall} MC, upper-bound guess)`
      )
    } else if (est?.usd !== undefined) {
      const basis = est.basis === 'history' ? `history; ${est.samples} samples` : 'prior; fewer than 5 samples'
      console.log(`PAID ${paid.row.harness}/${paid.row.model} ESTIMATE ${formatUsd(est.usd)} (${basis})`)
    } else {
      console.log('PAID none (no paid or per-call model in the chain)')
    }
  }
  if (all) {
    list.forEach((c, i) => {
      console.log(
        `CAND ${i + 1} ${c.row.harness}/${c.row.model} tier=${c.row.tier} effort=${c.effort} billing=${c.row.billing} class=${c.row.dataClass} status=${c.row.status}`
      )
    })
  }
  return 0
}

registerCommand('pick', runPick)
