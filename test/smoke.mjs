// Local harness smoke test: loads the plugin with a fake DSH context so the
// tool wiring, helper protocol, and capture path can be exercised without
// installing the bundle.
//
//   node test/smoke.mjs [--keys]

import { apply } from '../index.js'

const tools = new Map()
const skills = new Map()
let disposer = null

const fakeAttachments = {
  imageLimits: {
    maxImageBytes: 1048576,
    maxImagesPerMessage: 8,
    maxMessageImageBytes: 4194304,
    maxImagePixels: 640000,
    maxImageDimension: 8192,
    mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  },
  async saveImage(input) {
    return {
      attachmentId: `fake-${Math.random().toString(36).slice(2, 10)}`,
      mediaType: input.mediaType,
      bytes: input.data.length,
      width: 0,
      height: 0,
      name: input.name,
    }
  },
}

const ctx = {
  logger: { warn: (...a) => console.warn('[warn]', ...a), info: () => {}, debug: () => {} },
  tools: { register: (def) => { tools.set(def.name, def); return () => tools.delete(def.name) } },
  skills: { register: (def) => { skills.set(def.name, def); return () => skills.delete(def.name) } },
  effect: (fn) => { disposer = fn(); return () => {} },
  get: (name) => (name === 'attachments' ? fakeAttachments : undefined),
  on: () => () => {},
}

apply(ctx, {})

const names = [...tools.keys()]
console.log('tools:', names.join(', '))
console.log('skills:', [...skills.keys()].join(', '))

const call = async (name, args) => {
  const def = tools.get(name)
  if (!def) throw new Error(`no tool ${name}`)
  const t0 = Date.now()
  const value = await def.execute(args, { signal: new AbortController().signal })
  const blocks = def.output.render(args, value)
  const kinds = blocks.map((b) => b.type).join('+')
  console.log(`\n== ${name} ${JSON.stringify(args)} -> ${Date.now() - t0}ms blocks=${kinds}`)
  const text = blocks.find((b) => b.type === 'text')
  console.log(text.text.slice(0, 700))
  return value
}

await call('desktop_info', { listWindows: true, limit: 5 })
const shot = await call('desktop_screenshot', { maxWidth: 900, quality: 60 })
console.log('imageRefs:', JSON.stringify(shot.imageRefs))
const again = await call('desktop_screenshot', { maxWidth: 900, quality: 60, onlyIfChanged: true })
console.log('onlyIfChanged ->', JSON.stringify(again).slice(0, 200))
await call('desktop_mouse', { action: 'move', x: 200, y: 150 })
await call('desktop_act', {
  steps: [
    { op: 'move', x: 300, y: 200, durationMs: 300 },
    { op: 'wait', ms: 120 },
    { op: 'screenshot' },
  ],
  maxWidth: 640,
  quality: 55,
  grayscale: true,
})

if (process.argv.includes('--keys')) {
  await call('desktop_keyboard', { action: 'type', text: 'smoke 中文 123', cps: 30 })
  await call('desktop_keyboard', { action: 'press', key: 'ctrl+a' })
}

disposer?.()
console.log('\nOK')
