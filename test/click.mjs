// Click-accuracy + paste test: opens Notepad, focuses it, screenshots the
// window, clicks inside the text area using *image* coordinates, types, pastes
// a long string, then screenshots again.
//
//   DSH_GUI_CONTROL_KEEP_DIR=<dir> node test/click.mjs

import { spawn } from 'node:child_process'
import { apply } from '../index.js'

const tools = new Map()
const ctx = {
  logger: { warn: (...a) => console.warn('[warn]', ...a) },
  tools: { register: (def) => tools.set(def.name, def) },
  skills: { register: () => {} },
  effect: (fn) => { globalThis.__dispose = fn() },
  get: () => ({
    imageLimits: { maxImageBytes: 1048576, maxImagesPerMessage: 8, maxMessageImageBytes: 4194304, maxImagePixels: 640000, maxImageDimension: 8192, mediaTypes: ['image/png', 'image/jpeg'] },
    async saveImage(input) { return { attachmentId: 'fake', mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1 } },
  }),
  on: () => () => {},
}
apply(ctx, {})

const exec = { signal: new AbortController().signal }
const run = (n, a) => tools.get(n).execute(a, exec)

const proc = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' })
proc.unref()
await new Promise((r) => setTimeout(r, 2000))

const info = await run('desktop_info', { listWindows: true, limit: 40 })
const win = (info.windows || []).find((w) => w.pid === proc.pid) || (info.windows || []).find((w) => /notepad/i.test(w.process || ''))
if (!win) throw new Error('notepad window not found')
console.log('window:', win.hwnd, win.title, JSON.stringify(win.rect))

// Bring it up and take a window shot: this fixes the coordinate frame.
await run('desktop_act', { steps: [{ op: 'focus', window: win.hwnd }, { op: 'wait', ms: 400 }], capture: false })
const shot = await run('desktop_screenshot', { window: win.hwnd, maxWidth: 900, quality: 70 })
console.log('frame:', JSON.stringify(shot.region), 'image', JSON.stringify(shot.image), 'scale', JSON.stringify(shot.scale))

// Click inside the text area (image coordinates), then type.
const res = await run('desktop_act', {
  steps: [
    { op: 'click', x: 320, y: 200 },
    { op: 'type', text: 'clicked at image (320,200) then typed', cps: 60 },
    { op: 'press', key: 'enter' },
    { op: 'paste', text: 'pasted: 短文本用 type, 长文本用 paste —— 剪贴板会还原。 ' + 'x'.repeat(40) },
  ],
  window: win.hwnd,
  maxWidth: 900,
  quality: 72,
})
console.log('act:', res.ok, res.steps.map((s) => `${s.op}:${s.ok ? 'ok' : s.error}`).join(' | '))
console.log('savedPath:', res.savedPath || '(none)')

await new Promise((r) => setTimeout(r, 300))
await run('desktop_act', { steps: [{ op: 'focus', action: 'close', window: win.hwnd }], capture: false, stopOnError: false })
globalThis.__dispose?.()
