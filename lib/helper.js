// Helper process client.
//
// The Windows helper is a long-lived PowerShell 5.1 process that compiles a
// small C# bridge (P/Invoke into user32/gdi32) at startup and then speaks a
// line-delimited JSON protocol on stdin/stdout. One request per line, one
// response per line, matched by `id`.
//
// Requests are serialised through a promise queue because synthetic input is
// inherently stateful: two concurrent click batches would interleave their
// SendInput calls and produce garbage on screen.

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'

const DEFAULT_PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

export class HelperError extends Error {
  constructor(message, code, extra) {
    super(message)
    this.name = 'HelperError'
    this.code = code
    if (extra) Object.assign(this, extra)
  }
}

/**
 * The message the model sees when the user has pulled the emergency brake.
 * It is deliberately imperative: stop moving, stop typing, hand control back.
 */
export function haltMessage(level, detail = {}) {
  const since = detail.hotkey ? ` (热键 ${detail.hotkey})` : ''
  if (level >= 2) {
    return '⛔ 用户按下了 Ctrl+Shift+C 然后按 V，要求立刻结束本次对话。'
      + 'AI 对这台电脑的所有控制已被拦截，本次操作没有执行。'
      + '不要再调用任何工具，也不要继续当前任务；只用一两句话确认已经停手并说明被拦截，然后把控制权交回用户。'
  }
  return '⛔ 用户按下了 Ctrl+Shift+C 紧急停止。'
    + 'AI 对这台电脑的所有控制（鼠标/键盘/窗口/截图）已被拦截，本次操作没有执行。'
    + '不要重试、不要换别的工具绕过；向用户说明已经停手，等待用户进一步指示。'
    + `用户按 Ctrl+Shift+X 才会解除拦截${since}。`
}

export class WinHelper {
  constructor(scriptPath, options = {}) {
    this.scriptPath = scriptPath
    this.powershell = options.powershell || DEFAULT_PS
    this.logger = options.logger
    this.defaultTimeoutMs = options.timeoutMs || 60000
    this.proc = null
    this.readyPromise = null
    this.pending = new Map()
    this.decoder = new StringDecoder('utf8')
    this.buffer = ''
    this.seq = 0
    this.stderr = ''
    this.queue = Promise.resolve()
    this.disposed = false
    // Emergency-stop mirror: the helper owns the truth (it watches the global
    // hotkeys), Node keeps a cheap local copy refreshed from every response and
    // from the state file the helper rewrites on each hotkey.
    this.haltFile = null
    this.hotkeys = null
    this.halt = { level: 0, hotkey: '', at: 0, stopHotkey: null, resumeHotkey: null }
    this.haltReadAt = 0
  }

  // ---------------------------------------------------------------- lifecycle

  start() {
    if (this.readyPromise) return this.readyPromise
    this.readyPromise = new Promise((resolve, reject) => {
      let settled = false
      const done = (err) => {
        if (settled) return
        settled = true
        if (err) {
          this.readyPromise = null
          reject(err)
        } else resolve()
      }

      let proc
      try {
        proc = spawn(
          this.powershell,
          ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
        )
      } catch (e) {
        done(new HelperError(`无法启动 PowerShell helper: ${e?.message || e}`, 'SPAWN_FAILED'))
        return
      }

      this.proc = proc
      this.stderr = ''
      const timer = setTimeout(() => {
        done(new HelperError(`helper 启动超时 (20s)。stderr: ${this.stderr.slice(-600)}`, 'START_TIMEOUT'))
        try { proc.kill() } catch { /* ignore */ }
      }, 20000)

      proc.stdout.on('data', (chunk) => this.#onStdout(chunk, () => {
        clearTimeout(timer)
        done(null)
      }))
      proc.stderr.on('data', (chunk) => {
        this.stderr = (this.stderr + this.decoder.write(chunk)).slice(-4000)
      })
      proc.on('error', (e) => {
        clearTimeout(timer)
        done(new HelperError(`helper 进程错误: ${e?.message || e}`, 'PROC_ERROR'))
      })
      proc.on('exit', (code, signal) => {
        clearTimeout(timer)
        const detail = this.stderr.trim().slice(-1200)
        this.#failAll(new HelperError(
          `helper 进程退出 (code=${code}, signal=${signal || '-'})${detail ? `\n${detail}` : ''}`,
          'PROC_EXIT',
        ))
        this.proc = null
        this.readyPromise = null
        this.buffer = ''
        done(new HelperError(
          `helper 进程在启动阶段退出 (code=${code})${detail ? `\n${detail}` : ''}`,
          'PROC_EXIT',
        ))
      })
    })
    return this.readyPromise
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    const proc = this.proc
    if (!proc) return
    try { proc.stdin.write('{"id":"__bye","cmd":"quit"}\n') } catch { /* ignore */ }
    try {
      proc.stdin.end()
    } catch { /* ignore */ }
    setTimeout(() => {
      try { if (!proc.killed) proc.kill() } catch { /* ignore */ }
    }, 400).unref?.()
    this.#failAll(new HelperError('helper 已关闭', 'DISPOSED'))
    this.proc = null
    this.readyPromise = null
  }

  // ------------------------------------------------------------------ plumbing

  #onStdout(chunk, onReady) {
    this.buffer += this.decoder.write(chunk)
    let idx
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg && msg.ready === true) {
        this.haltFile = typeof msg.haltFile === 'string' ? msg.haltFile : null
        this.hotkeys = msg.hotkeys || null
        onReady()
        continue
      }
      if (msg && typeof msg.halt === 'number') this.#absorbHalt(msg.halt)
      const waiter = msg && msg.id !== undefined ? this.pending.get(String(msg.id)) : this.pending.get('__last')
      if (waiter) {
        this.pending.delete(String(msg.id))
        waiter.resolve(msg)
      }
    }
  }

  #failAll(error) {
    for (const waiter of this.pending.values()) waiter.reject(error)
    this.pending.clear()
  }

  // ----------------------------------------------------------- emergency stop

  #absorbHalt(level) {
    const n = Number(level) || 0
    if (n === this.halt.level) return
    if (n === 0) {
      this.halt = { ...this.halt, level: 0, hotkey: '' }
      return
    }
    this.halt = { ...this.halt, level: n }
    this.haltReadAt = 0 // force a file read so the details are current
  }

  /**
   * Current halt state. The helper rewrites a tiny JSON file on every hotkey,
   * so this is a cheap way to stay truthful without polling the process.
   */
  refreshHalt(options = {}) {
    const file = this.haltFile
    if (!file) return this.halt
    const now = Date.now()
    if (!options.force && now - this.haltReadAt < 120) return this.halt
    this.haltReadAt = now
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      this.halt = {
        level: Number(data.level) || 0,
        hotkey: String(data.hotkey || ''),
        at: Number(data.at) || 0,
        stopHotkey: data.stop !== false,
        resumeHotkey: data.resume !== false,
      }
    } catch { /* not written yet, or helper is gone */ }
    return this.halt
  }

  /** Throw unless the user has left the brakes off. */
  assertRunning(label = '') {
    const h = this.refreshHalt({ force: true })
    if (!h || h.level === 0) return h
    throw new HelperError(
      haltMessage(h.level, h) + (label ? `（被拦截的操作: ${label}）` : ''),
      'HALTED',
      { halted: true, haltLevel: h.level, haltHotkey: h.hotkey, haltAt: h.at, blocked: label },
    )
  }

  /**
   * Send one command and resolve with its response object (the helper sets
   * `ok:false` + `error` instead of throwing, so callers decide).
   */
  async call(request, options = {}) {
    if (this.disposed) throw new HelperError('helper 已关闭', 'DISPOSED')
    const run = async () => {
      await this.start()
      return this.#send(request, options)
    }
    // Chain on the queue, but never let one failure poison later commands.
    const result = this.queue.then(run, run)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  #send(request, options) {
    const proc = this.proc
    if (!proc || proc.exitCode !== null) throw new HelperError('helper 进程不可用', 'NO_PROC')
    const id = String(++this.seq)
    const payload = JSON.stringify({ ...request, id })
    const timeoutMs = options.timeoutMs || this.defaultTimeoutMs

    return new Promise((resolve, reject) => {
      // Both terminal paths must tear down every timer and listener they set:
      // a leaked 'abort' listener keeps the caller's AbortSignal alive (and
      // fires into an already-settled promise) for as long as the caller holds it.
      const cleanup = () => {
        clearTimeout(timer)
        options.signal?.removeEventListener?.('abort', onAbort)
        this.pending.delete(id)
      }

      const timer = setTimeout(() => {
        cleanup()
        reject(new HelperError(`helper 命令超时 ${timeoutMs}ms: ${request.cmd}`, 'TIMEOUT'))
      }, timeoutMs)

      const onAbort = () => {
        cleanup()
        reject(new HelperError('命令已取消', 'ABORTED'))
      }
      if (options.signal) {
        if (options.signal.aborted) { onAbort(); return }
        options.signal.addEventListener('abort', onAbort, { once: true })
      }

      this.pending.set(id, {
        resolve: (msg) => {
          cleanup()
          resolve(msg)
        },
        reject: (err) => {
          cleanup()
          reject(err)
        },
      })

      try {
        proc.stdin.write(`${payload}\n`)
      } catch (e) {
        cleanup()
        reject(new HelperError(`写入 helper 失败: ${e?.message || e}`, 'WRITE_FAILED'))
      }
    })
  }

  /**
   * Convenience wrapper: run a command and throw a readable error when the
   * helper reports failure.
   */
  async run(request, options = {}) {
    const res = await this.call(request, options)
    if (res && res.ok === false) {
      const text = String(res.error || '')
      // The helper reports the stop as `HALTED: ...`, but PowerShell wraps the
      // message of a throwing .NET call ("Exception calling "Key" ...: "HALTED").
      if (/\bHALTED:/.test(text)) {
        // The helper refused mid-flight: refresh the details and tell the model
        // what the human just did, in words it can act on.
        const h = this.refreshHalt({ force: true })
        throw new HelperError(haltMessage(Math.max(1, h.level || res.halt || 1), h), 'HALTED', {
          halted: true,
          haltLevel: Math.max(1, h.level || res.halt || 1),
          haltHotkey: h.hotkey,
          blocked: request.cmd,
        })
      }
      throw new HelperError(text || `${request.cmd} 失败`, 'HELPER_REPORTED')
    }
    return res
  }
}
