export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let fieldQuoted = false
  const pushField = () => {
    row.push(fieldQuoted ? field : field.trim())
    field = ''
    fieldQuoted = false
  }
  const pushRow = () => {
    rows.push(row)
    row = []
  }
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
        } else {
          inQuotes = false
          i += 1
        }
      } else {
        field += c
        i += 1
      }
    } else if (c === '"') {
      inQuotes = true
      fieldQuoted = true
      i += 1
    } else if (c === ',') {
      pushField()
      i += 1
    } else if (c === '\r' && text[i + 1] === '\n') {
      pushField()
      pushRow()
      i += 2
    } else if (c === '\n' || c === '\r') {
      pushField()
      pushRow()
      i += 1
    } else {
      field += c
      i += 1
    }
  }
  pushField()
  pushRow()
  const out: Record<string, string>[] = []
  let header: string[] | undefined
  for (const r of rows) {
    if (r.length === 1 && r[0] === '') continue
    if (!header) {
      if (r[0].startsWith('#')) continue
      header = r
      continue
    }
    if (r.length === 1 && (r[0] === '' || r[0].startsWith('#'))) continue
    const obj: Record<string, string> = {}
    header.forEach((h, idx) => {
      obj[h] = r[idx] ?? ''
    })
    out.push(obj)
  }
  return out
}
