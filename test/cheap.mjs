// Cheap-sensing test: OCR, colour probe, and click-by-text, without pictures.
//
//   node test/cheap.mjs

import { apply } from '../index.js'

const tools = new Map()
let disposer = null
const ctx = {
  logger: { warn: (...a) => console.warn('[warn]', ...a), info: () => {}, debug: () => {} },
  tools: { register: (def) => { tools.set(def.name, def); return () => tools.delete(def.name) } },
  skills: { register: () => () => {} },
  effect: (fn) => { disposer = fn(); return () => {} },
  get: () => undefined,
  on: () => () => {},
}

apply(ctx, {})

const call = async (name, args) => {
  const tool = tools.get(name)
  if (!tool) throw new Error(`missing tool ${name}`)
  const value = await tool.execute(args, {})
  const text = tool.output.render(args, value)[0].text
  return { value, text }
}

let failed = 0
const show = (label, text, budget) => {
  const t = text.length > budget ? `${text.slice(0, budget)}...` : text
  console.log(`== ${label} (${text.length} chars) -> ${t}`)
}

// 1. grid: coarse layout map of the whole screen as colours
{
  const t0 = Date.now()
  const { text } = await call('desktop_find', { mode: 'grid', cols: 8, rows: 4 })
  console.log(`grid ${Date.now() - t0}ms`)
  show('grid', text, 260)
}

// 2. points: sample three pixels
{
  const { text } = await call('desktop_find', { mode: 'points', space: 'screen', points: [{ x: 10, y: 10 }, { x: 400, y: 300 }, { x: 1900, y: 1070 }] })
  show('points', text, 260)
}

// 3. find: any large dark-blue area (harmless, just to exercise the search)
{
  const t0 = Date.now()
  const { value, text } = await call('desktop_find', { mode: 'find', color: '#1e2a38', tolerance: 40, minArea: 3000, maxResults: 3 })
  console.log(`find ${Date.now() - t0}ms total=${value.total}`)
  show('find', text, 300)
}

// 4. ocr: read whatever text is on screen
{
  const t0 = Date.now()
  const { value, text } = await call('desktop_ocr', {})
  console.log(`ocr ${Date.now() - t0}ms count=${value.count} engine=${value.engine}`)
  show('ocr', text, 320)
  const withCoords = value.lines.filter((l) => l.w > 0 && l.h > 0).length
  if (value.count > 0 && withCoords === 0) { console.log('FAIL: ocr lines carry no rects'); failed++ }
}

// 5. click_text with dryRun: must locate text without clicking
{
  const first = (await call('desktop_ocr', {})).value.lines.find((l) => l.t && l.t.trim().length >= 2)
  if (!first) {
    console.log('SKIP click_text (nothing on screen)')
  } else {
    const needle = first.t.trim().slice(0, 2)
    const { value, text } = await call('desktop_click_text', { text: needle, dryRun: true })
    console.log(`click_text needle=${JSON.stringify(needle)} ok=${value.ok}`)
    show('click_text', text, 260)
    if (!value.ok) { console.log('FAIL: click_text did not find a string OCR just returned'); failed++ }
  }
}

if (typeof disposer === 'function') disposer()
console.log(failed ? `FAILED ${failed}` : 'OK')
process.exit(failed ? 1 : 0)
