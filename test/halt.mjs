// Emergency-stop test: press the real global hotkeys and check that the plugin
// refuses, reports, and stays blocked until the user resumes.
//
//   node test/halt.mjs

import { spawnSync } from 'node:child_process'
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
  const r = spawnSync('powershell.exe', args, { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`sendhotkey failed: ${r.stderr}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const status = async () => (await run('desktop_guard', {}))

// 1. running
await run('desktop_info', {})
let s = await status()
console.log('before:', JSON.stringify({ halted: s.halted, level: s.level, reg: s.hotkeys.registration }))
if (s.halted) throw new Error('should start un-halted')

// 2. Ctrl+Shift+C -> halt
hotkey('ctrl+shift+c')
await sleep(300)
s = await status()
console.log('after stop:', JSON.stringify({ halted: s.halted, level: s.level, meaning: s.meaning }))
if (!s.halted || s.level !== 1) throw new Error('stop hotkey did not halt')

// 3. every control tool must refuse
for (const [name, args] of [
  ['desktop_info', {}],
  ['desktop_screenshot', {}],
  ['desktop_mouse', { action: 'move', x: 100, y: 100 }],
  ['desktop_keyboard', { action: 'type', text: 'x' }],
  ['desktop_act', { steps: [{ op: 'wait', ms: 10 }] }],
]) {
  try {
    await run(name, args)
    throw new Error(`${name} was NOT blocked`)
  } catch (e) {
    const ok = e.code === 'HALTED' && /Ctrl\+Shift\+C/.test(e.message)
    console.log(`  ${name}: blocked=${ok} code=${e.code}`)
    if (!ok) throw new Error(`${name} blocked but message is wrong: ${e.message}`)
  }
}

// 4. Ctrl+Shift+X -> resume
hotkey('ctrl+shift+x')
await sleep(350)
s = await status()
console.log('after resume:', JSON.stringify({ halted: s.halted, level: s.level }))
if (s.halted) throw new Error('resume hotkey did not clear the halt')
await run('desktop_mouse', { action: 'move', x: 60, y: 60, durationMs: 120 })
console.log('  desktop_mouse after resume: ok')

// 5. Ctrl+Shift+C then V -> terminate level
hotkey('ctrl+shift+c', 'v')
await sleep(400)
s = await status()
console.log('after stop+v:', JSON.stringify({ halted: s.halted, level: s.level, meaning: s.meaning }))
if (s.level !== 2) throw new Error(`expected level 2, got ${s.level}`)
try {
  await run('desktop_screenshot', {})
  throw new Error('screenshot was NOT blocked at level 2')
} catch (e) {
  const ok = e.code === 'HALTED' && /结束本次对话/.test(e.message)
  console.log(`  terminate message: ${ok}`)
  if (!ok) throw new Error(`wrong terminate message: ${e.message}`)
}

// 6. clean up: resume so later tests are not blocked
hotkey('ctrl+shift+x')
await sleep(300)
s = await status()
console.log('final:', JSON.stringify({ halted: s.halted, level: s.level }))

globalThis.__dispose?.()
console.log('\nOK')
