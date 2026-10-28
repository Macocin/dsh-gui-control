// Framing test: prove that desktop_act step coordinates follow the *target*
// of the call, not a stale frame left over from an unrelated screenshot.
//
//   node test/framing.mjs

import { spawn } from 'node:child_process'
import { apply } from '../index.js'

const tools = new Map()
apply({
  logger: { warn: (...a) => console.warn('[warn]', ...a) },
  tools: { register: (d) => tools.set(d.name, d) },
  skills: { register: () => {} },
  effect: (fn) => { globalThis.__dispose = fn() },
  get: () => ({
    imageLimits: { maxImageBytes: 1048576, maxImagesPerMessage: 8, maxMessageImageBytes: 4194304, maxImagePixels: 640000, maxImageDimension: 8192, mediaTypes: ['image/png', 'image/jpeg'] },
    async saveImage(input) { return { attachmentId: 'fake', mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1 } },
  }),
  on: () => () => {},
}, {})

const exec = { signal: new AbortController().signal }
const run = (n, a) => tools.get(n).execute(a, exec)

const proc = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' })
proc.unref()
await new Promise((r) => setTimeout(r, 2000))

const info = await run('desktop_info', { listWindows: true, limit: 40 })
const win = (info.windows || []).find((w) => w.pid === proc.pid) || (info.windows || []).find((w) => /notepad/i.test(w.process || ''))
if (!win) throw new Error('notepad window not found')
console.log('notepad rect:', JSON.stringify(win.rect))

// Poison the frame with a small, unrelated screenshot.
await run('desktop_screenshot', { region: { left: 0, top: 1040, width: 200, height: 30 } })

// Now an act targeting the notepad window: image (100,100) must land inside
// the window, i.e. screen = rect.left + 100/scale.
const res = await run('desktop_act', {
  steps: [{ op: 'move', x: 100, y: 100, durationMs: 200 }],
  window: win.hwnd,
  maxWidth: 720,
  quality: 60,
})
const scale = 720 / win.rect.width
const expectX = Math.round(win.rect.left + 100 / scale)
const expectY = Math.round(win.rect.top + 100 / scale)
const gotX = res.steps[0].cursor.x
const gotY = res.steps[0].cursor.y
console.log(`scale=${scale.toFixed(4)} expect=(${expectX},${expectY}) got=(${gotX},${gotY})`,
  Math.abs(gotX - expectX) <= 2 && Math.abs(gotY - expectY) <= 2 ? 'PASS' : 'FAIL')

await run('desktop_act', { steps: [{ op: 'focus', action: 'close', window: win.hwnd }], capture: false, stopOnError: false })
globalThis.__dispose?.()
