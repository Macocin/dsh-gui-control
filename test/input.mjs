// Input-path test: opens Notepad, focuses it by hwnd, types ASCII + Chinese,
// screenshots the window, and closes it again.
//
//   node test/input.mjs

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
    async saveImage(input) {
      return { attachmentId: 'fake', mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1, name: input.name }
    },
  }),
  on: () => () => {},
}

apply(ctx, {})

const exec = { signal: new AbortController().signal }
const run = (n, a) => tools.get(n).execute(a, exec)

const notepad = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' })
notepad.unref()
await new Promise((r) => setTimeout(r, 1800))

const info = await run('desktop_info', { listWindows: true, limit: 30 })
const win = (info.windows || []).find((w) => /notepad/i.test(w.process || ''))
if (!win) {
  console.log('windows:', JSON.stringify(info.windows, null, 1).slice(0, 1500))
  throw new Error('notepad window not found')
}
console.log('notepad window:', win.hwnd, JSON.stringify(win.title), JSON.stringify(win.rect))

const typed = 'dsh gui-control 中文输入测试 ✓ 12345'
const res = await run('desktop_act', {
  steps: [
    { op: 'focus', window: win.hwnd },
    { op: 'wait', ms: 350 },
    { op: 'type', text: typed, cps: 40 },
    { op: 'press', key: 'enter' },
    { op: 'type', text: 'second line: the agent typed this', cps: 55 },
  ],
  window: win.hwnd,
  maxWidth: 900,
  quality: 70,
  capture: true,
})
console.log('act ok:', res.ok, 'steps:', res.steps.map((s) => `${s.op}:${s.ok ? 'ok' : s.error}`).join(' | '))
console.log('image:', JSON.stringify(res.image), 'region:', JSON.stringify(res.region))

await new Promise((r) => setTimeout(r, 250))
const closed = await run('desktop_act', {
  steps: [{ op: 'focus', action: 'close', window: win.hwnd }],
  capture: false,
})
console.log('close:', JSON.stringify(closed.steps))

globalThis.__dispose?.()
