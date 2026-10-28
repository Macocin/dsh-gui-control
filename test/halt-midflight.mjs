// Mid-flight test: a long typing run must stop within a fraction of a second
// when the user hits Ctrl+Shift+C, not finish the whole string first.
//
//   node test/halt-midflight.mjs

import { spawn, spawnSync } from 'node:child_process'
import { apply } from '../index.js'

const tools = new Map()
apply({
  logger: { warn: (...a) => console.warn('[warn]', ...a) },
  tools: { register: (d) => tools.set(d.name, d) },
  skills: { register: () => {} },
  effect: (fn) => { globalThis.__dispose = fn() },
  get: () => undefined,
  on: () => () => {},
}, {})

const exec = { signal: new AbortController().signal }
const run = (n, a) => tools.get(n).execute(a, exec)
const hotkey = (combo, then = '') => {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'test/_sendhotkey.ps1', combo]
  if (then) args.push('-Then', then)
  spawnSync('powershell.exe', args, { encoding: 'utf8' })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const proc = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' })
proc.unref()
await sleep(1800)
const info = await run('desktop_info', { listWindows: true, limit: 40 })
const win = (info.windows || []).find((w) => w.pid === proc.pid) || (info.windows || []).find((w) => /notepad/i.test(w.process || ''))
if (!win) throw new Error('notepad window not found')
await run('desktop_act', { steps: [{ op: 'focus', window: win.hwnd }, { op: 'wait', ms: 300 }], capture: false })

// ~60 seconds of typing at 12 cps; we interrupt it after 600 ms.
const text = 'the quick brown fox jumps over the lazy dog. '.repeat(25)
const started = Date.now()
const typing = run('desktop_keyboard', { action: 'type', text, cps: 12 })
  .then(() => ({ ok: true }))
  .catch((e) => ({ ok: false, error: e, at: Date.now() }))

await sleep(600)
hotkey('ctrl+shift+c')
const outcome = await typing
const elapsed = Date.now() - started

if (outcome.ok) throw new Error('typing finished instead of being interrupted')
const err = outcome.error
console.log(`interrupted after ${elapsed}ms (rejected ${outcome.at - started}ms in), code=${err.code}`)
console.log(`message starts: ${String(err.message).slice(0, 48)}...`)
if (err.code !== 'HALTED') throw new Error(`expected HALTED, got ${err.code}`)
if (elapsed > 2500) throw new Error(`too slow to stop: ${elapsed}ms`)

// Stopped meaningfully before the end: fewer than ~15 chars could have landed.
hotkey('ctrl+shift+x')
await sleep(300)
await run('desktop_act', { steps: [{ op: 'focus', action: 'close', window: win.hwnd }], capture: false, stopOnError: false })
hotkey('ctrl+shift+x')
globalThis.__dispose?.()
console.log('\nOK')
