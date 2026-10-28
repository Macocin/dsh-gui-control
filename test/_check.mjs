// Tool results must survive JSON round-trips unchanged: DSH rejects values it
// cannot serialise losslessly (an `undefined` property is the usual culprit).
// The harness here does not run that validation, so check it explicitly.

export function assertPlain(value, label = 'value') {
  const seen = new Set()
  const walk = (v, at) => {
    if (v === undefined) throw new Error(`${label}${at} is undefined (not lossless JSON)`)
    if (typeof v === 'function' || typeof v === 'symbol') throw new Error(`${label}${at} is ${typeof v}`)
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`${label}${at} is ${v}`)
    if (v === null || typeof v !== 'object') return
    if (seen.has(v)) throw new Error(`${label}${at} is circular`)
    seen.add(v)
    if (Array.isArray(v)) v.forEach((item, i) => walk(item, `${at}[${i}]`))
    else for (const [k, item] of Object.entries(v)) walk(item, `${at}.${k}`)
  }
  walk(value, '')
  JSON.stringify(value)
  return value
}
