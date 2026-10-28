// dsh-gui-control — let the model look at the screen and drive the mouse and
// keyboard like a person would.
//
// Architecture: this host plugin never touches Win32 itself. It talks to a
// long-lived PowerShell 5.1 process (`helper/win-helper.ps1`) that compiles a
// tiny C# bridge on startup and answers line-delimited JSON commands. Screenshots
// land in a temp file, get encoded by the helper, and are handed to the DSH
// attachment service so the model sees a real image attachment.
//
// Coordinate model: every mouse tool speaks the pixel space of the most recent
// screenshot by default, because that is the only space the model can actually
// see. `space: 'screen'` switches to raw physical screen pixels.

import { promises as fsp, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WinHelper, HelperError, haltMessage } from './lib/helper.js'

export const name = 'gui-control'
export const inject = ['tools', 'skills']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_HELPER = path.join(HERE, 'helper', 'win-helper.ps1')
const SKILL_PATH = path.join(HERE, 'skill.md')

const DEFAULTS = {
  maxWidth: 1280,
  quality: 68,
  format: 'jpeg',
  showCursor: true,
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms | 0)))

function intOr(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.round(n)
}

function clampRegion(region) {
  const left = intOr(region.left, 0)
  const top = intOr(region.top, 0)
  const width = Math.max(16, intOr(region.width, 0))
  const height = Math.max(16, intOr(region.height, 0))
  return { left, top, width, height }
}

export function apply(ctx, config = {}) {
  const helper = new WinHelper(config.helperPath || DEFAULT_HELPER, {
    powershell: config.powershell,
    logger: ctx.logger,
    timeoutMs: config.timeoutMs || 60000,
  })
  ctx.effect(() => () => helper.dispose(), 'gui-control: helper process')

  // Most recent frame: the pixel space the model is currently looking at.
  let frame = null
  let lastHash = null
  let tmpSeq = 0

  // Emergency stop. The helper owns the switch (it watches Ctrl+Shift+C and
  // Ctrl+Shift+X globally); every control tool checks it before touching the
  // machine, and the helper refuses mid-flight, so a long `type` stops within
  // a few keystrokes.
  function guard(label) {
    helper.assertRunning(label)
  }

  // ---------------------------------------------------------------- utilities

  function tmpFile(ext) {
    const dir = path.join(tmpdir(), 'dsh-gui-control')
    return fsp.mkdir(dir, { recursive: true }).then(() => path.join(dir, `f${process.pid}-${++tmpSeq}.${ext}`))
  }

  function toScreen(x, y, space) {
    const useImage = space !== 'screen' && frame
    if (!useImage) return { x: intOr(x, 0), y: intOr(y, 0) }
    return {
      x: Math.round(frame.region.left + intOr(x, 0) / frame.scaleX),
      y: Math.round(frame.region.top + intOr(y, 0) / frame.scaleY),
    }
  }

  function describeSpace(space) {
    return space === 'screen' || !frame ? 'screen' : 'image'
  }

  // Monitor geometry rarely changes; caching keeps capture latency down when
  // the model takes a burst of screenshots.
  let infoCache = { at: 0, value: null }

  async function layout(signal) {
    if (infoCache.value && Date.now() - infoCache.at < 15000) return infoCache.value
    const res = await helper.run({ cmd: 'info' }, { signal, timeoutMs: 15000 })
    infoCache = { at: Date.now(), value: res }
    return res
  }

  async function resolveRegion(args, signal) {
    if (args.region) {
      const r = clampRegion(args.region)
      return { ...r, mode: 'region' }
    }
    if (args.window !== undefined && args.window !== null && args.window !== '') {
      const req = { cmd: 'window', action: 'info' }
      if (typeof args.window === 'number') req.hwnd = args.window
      else req.title = String(args.window)
      const res = await helper.run(req, { signal, timeoutMs: 15000 })
      const rect = res.window?.rect || {}
      if (!rect.width || !rect.height) throw new Error(`找不到窗口: ${args.window}`)
      return { ...clampRegion(rect), mode: 'window', title: res.window.title }
    }
    if (args.monitor !== undefined && args.monitor !== null) {
      const res = await layout(signal)
      const mons = res.monitors || []
      const mon = mons.find((m) => m.index === intOr(args.monitor, 0)) || mons[0]
      if (!mon) throw new Error('找不到显示器')
      const b = mon.bounds
      return { left: b.left, top: b.top, width: b.width, height: b.height, mode: 'monitor' }
    }
    // Whole virtual desktop.
    if (args.fullScreen === true) {
      const res = await layout(signal)
      const v = res.virtualScreen || { left: 0, top: 0, width: 1920, height: 1080 }
      return { left: v.left, top: v.top, width: v.width, height: v.height, mode: 'screen' }
    }
    // Default: the primary monitor is what a person means by "the screen".
    const res = await layout(signal)
    const mons = res.monitors || []
    const mon = mons.find((m) => m.primary) || mons[0]
    if (!mon) throw new Error('找不到显示器')
    const b = mon.bounds
    return { left: b.left, top: b.top, width: b.width, height: b.height, mode: 'monitor', primary: true }
  }

  // Capture → temp file → (optionally) attachment. `attach:false` turns this
  // into a cheap change-detection probe that never costs the model tokens.
  async function capture(args, opts = {}) {
    guard('screenshot')
    const signal = opts.signal
    const region = opts.region || (await resolveRegion(args, signal))
    const format = args.format === 'png' ? 'png' : DEFAULTS.format
    const quality = Math.min(95, Math.max(20, intOr(args.quality, DEFAULTS.quality)))
    const maxWidth = Math.max(0, intOr(args.maxWidth, DEFAULTS.maxWidth))
    const maxHeight = Math.max(0, intOr(args.maxHeight, 0))
    const grayscale = args.grayscale === true || opts.grayscale === true
    const showCursor = args.showCursor === undefined ? DEFAULTS.showCursor : args.showCursor !== false
    const grid = args.grid === true || opts.grid === true

    const attachments = ctx.get('attachments')
    const byteLimit = attachments?.imageLimits?.maxImageBytes || 1048576

    const file = await tmpFile(format === 'png' ? 'png' : 'jpg')
    let res
    try {
      res = await helper.run({
        cmd: 'capture',
        left: region.left,
        top: region.top,
        width: region.width,
        height: region.height,
        format,
        quality,
        maxWidth,
        maxHeight,
        grayscale,
        cursor: showCursor,
        grid,
        path: file,
        maxBytes: byteLimit,
      }, { signal, timeoutMs: opts.timeoutMs || 30000 })
    } catch (e) {
      await fsp.rm(file, { force: true }).catch(() => {})
      throw e
    }

    let bytes
    try {
      bytes = await fsp.readFile(file)
    } catch (e) {
      throw new Error(`截图文件读取失败: ${e?.message || e}`)
    }
    const hash = createHash('sha256').update(bytes).digest('hex')

    const scaleX = res.width / Math.max(1, res.srcWidth)
    const scaleY = res.height / Math.max(1, res.srcHeight)
    const nextFrame = {
      region: res.region,
      srcWidth: res.srcWidth,
      srcHeight: res.srcHeight,
      width: res.width,
      height: res.height,
      scaleX,
      scaleY,
      at: Date.now(),
    }

    const meta = {
      ok: true,
      mode: region.mode || 'region',
      image: { width: res.width, height: res.height, mediaType: res.mediaType, bytes: bytes.length },
      region: res.region,
      scale: { x: Number(scaleX.toFixed(4)), y: Number(scaleY.toFixed(4)) },
      cursor: res.cursor,
      cursorInImage: cursorInImage(res.cursor, res.region, scaleX, scaleY),
      hash,
    }
    if (region.title) meta.window = region.title

    if (opts.attach === false) {
      await fsp.rm(file, { force: true }).catch(() => {})
      // A probe must not move the coordinate frame the model is looking at:
      // the model never saw this image. Only seed the frame if there is none.
      if (opts.track !== false) {
        frame = nextFrame
        lastHash = hash
      } else if (!frame) {
        frame = nextFrame
      }
      return { meta, ref: null }
    }

    let ref = null
    let attachError = null
    if (!attachments) {
      attachError = '当前 profile 没有 attachments 服务, 图像无法回传给模型'
    } else if (bytes.length > byteLimit) {
      attachError = `图像 ${bytes.length} 字节超过上限 ${byteLimit}`
    } else {
      try {
        ref = await attachments.saveImage({
          data: bytes,
          mediaType: res.mediaType,
          name: `screen-${Date.now()}.${format === 'png' ? 'png' : 'jpg'}`,
        })
      } catch (e) {
        attachError = `附件保存失败: ${e?.message || e}`
      }
    }
    if (attachError) meta.imageError = attachError
    // Debug aid: keep frames on disk when explicitly asked to.
    const keepDir = process.env.DSH_GUI_CONTROL_KEEP_DIR
    if (keepDir) {
      try {
        await fsp.mkdir(keepDir, { recursive: true })
        const dest = path.join(keepDir, path.basename(file))
        await fsp.copyFile(file, dest)
        meta.savedPath = dest
      } catch { /* debug-only nicety */ }
    }
    await fsp.rm(file, { force: true }).catch(() => {})

    frame = nextFrame
    lastHash = hash
    meta.coord = 'image'
    if (ref) meta.imageRef = { width: ref.width, height: ref.height, mediaType: ref.mediaType }
    return { meta, ref }
  }

  function cursorInImage(cursor, region, scaleX, scaleY) {
    if (!cursor) return null
    const x = (cursor.x - region.left) * scaleX
    const y = (cursor.y - region.top) * scaleY
    if (x < 0 || y < 0 || x > region.width * scaleX || y > region.height * scaleY) return null
    return { x: Math.round(x), y: Math.round(y) }
  }

  function imageBlocks(value) {
    const blocks = [{ type: 'text', text: JSON.stringify(stripRefs(value)) }]
    for (const ref of value.imageRefs || []) blocks.push({ type: 'image', attachment: ref })
    return blocks
  }

  function stripRefs(value) {
    if (!value || (!value.imageRefs && !value.images)) return value
    const { imageRefs, images, ...rest } = value
    return rest
  }

  async function shot(args, exec) {
    const { meta, ref } = await capture(args, { signal: exec?.signal })
    const value = { ...meta }
    if (ref) value.imageRefs = [pickRef(ref)]
    return value
  }

  function pickRef(ref) {
    return {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name ? { name: ref.name } : {}),
    }
  }

  // ------------------------------------------------------------------- tools

  const IMAGE_OUTPUT = {
    schema: { type: 'object' },
    render: (_args, value) => imageBlocks(value),
  }
  const TEXT_OUTPUT = {
    schema: { type: 'object' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  }

  ctx.tools.register({
    name: 'desktop_info',
    description:
      '查看当前桌面状态: 显示器(物理像素/DPI)、光标位置、前台窗口、以及可选窗口列表。不返回截图, 不耗图像 token。'
      + ' 开始操作界面前想确认窗口标题或屏幕分辨率时用它; 想看画面本身请用 desktop_screenshot。',
    parameters: {
      type: 'object',
      properties: {
        listWindows: { type: 'boolean', description: '是否列出可见窗口 (默认 false)' },
        limit: { type: 'number', description: '窗口列表上限, 默认 20' },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      guard('desktop_info')
      const res = await helper.run({
        cmd: 'info',
        includeWindows: args.listWindows === true,
        limit: intOr(args.limit, 20),
      }, { signal: exec?.signal, timeoutMs: 15000 })
      infoCache = { at: Date.now(), value: res }
      return {
        ok: true,
        monitors: res.monitors,
        virtualScreen: res.virtualScreen,
        cursor: res.cursor,
        foreground: res.foreground,
        ...(res.windows ? { windows: res.windows } : {}),
      }
    },
  })

  ctx.tools.register({
    name: 'desktop_screenshot',
    description:
      '截取屏幕并返回图像。默认截主显示器、缩放到宽 1280、JPEG 质量 68 (省 token), 并在光标处画绿色准星。'
      + ' 可只截某个窗口 (window) 或区域 (region) 以进一步省 token; grayscale=true 看文字表格更省; '
      + 'onlyIfChanged=true 时若画面与上一帧完全相同则不返回图像 (只回 unchanged)。'
      + ' 返回的 region/scale 决定后续鼠标工具默认的坐标系: 直接使用图像里的像素坐标即可。'
      + ' 读屏优先级最低 (L3/L4): 能用 desktop_a11y / desktop_ocr / desktop_find 解决的就别截图。',
    parameters: {
      type: 'object',
      properties: {
        window: { type: ['string', 'number'], description: '只截该窗口: 标题子串 或 hwnd' },
        region: {
          type: 'object',
          description: '只截屏幕区域 (物理像素)',
          properties: {
            left: { type: 'number' }, top: { type: 'number' },
            width: { type: 'number' }, height: { type: 'number' },
          },
        },
        monitor: { type: 'number', description: '只截某个显示器 (index)' },
        fullScreen: { type: 'boolean', description: '截整个虚拟桌面 (多显示器拼接)' },
        maxWidth: { type: 'number', description: '图像最大宽度, 默认 1280; 0=不缩放 (费 token)' },
        maxHeight: { type: 'number', description: '图像最大高度, 默认不限' },
        quality: { type: 'number', description: 'JPEG 质量 20-95, 默认 68' },
        format: { type: 'string', enum: ['jpeg', 'png'], description: 'png 无损但更大; 默认 jpeg' },
        grayscale: { type: 'boolean', description: '转灰度, 读文字/表格时省 token' },
        showCursor: { type: 'boolean', description: '是否标注光标位置, 默认 true' },
        grid: { type: 'boolean', description: '叠加 100px 坐标网格 (读坐标用), 默认 false' },
        onlyIfChanged: { type: 'boolean', description: '画面与上一帧相同则不返回图像' },
        delayMs: { type: 'number', description: '截图前先等这么久 (等待界面加载)' },
      },
    },
    output: IMAGE_OUTPUT,
    async execute(args, exec) {
      guard('desktop_screenshot')
      if (intOr(args.delayMs, 0) > 0) await sleep(intOr(args.delayMs, 0))
      if (args.onlyIfChanged === true && lastHash) {
        const { meta } = await capture(args, { signal: exec?.signal, attach: false })
        if (meta.hash === lastHash) {
          return { ok: true, unchanged: true, image: meta.image, region: meta.region, hint: '画面与上一帧相同, 未重复发送图像' }
        }
      }
      return shot(args, exec)
    },
  })

  ctx.tools.register({
    name: 'desktop_mouse',
    description:
      '移动/点击/拖拽/滚轮, 走贝塞尔曲线 + 缓动 + 抖动的类人轨迹 (带落点修正), 不是瞬移。'
      + ' x/y 默认是「最近一次截图」的像素坐标 (可直接用图像里量到的位置); space="screen" 时是屏幕物理坐标。'
      + ' 点击前会自动把光标移到目标; action=click/right/double 时 x,y 可省略 (原地点击)。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['move', 'click', 'right', 'double', 'middle', 'down', 'up', 'drag', 'scroll'],
          description: '动作类型',
        },
        x: { type: 'number', description: '目标 x (截图坐标, 或 space=screen 时的屏幕坐标)' },
        y: { type: 'number', description: '目标 y' },
        toX: { type: 'number', description: 'drag 终点 x' },
        toY: { type: 'number', description: 'drag 终点 y' },
        space: { type: 'string', enum: ['image', 'screen'], description: '坐标系, 默认 image (最近截图)' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: '按键, 默认 left' },
        count: { type: 'number', description: '点击次数 (1-4), 或 scroll 的滚动格数' },
        durationMs: { type: 'number', description: '移动耗时, 0=按距离自动 (人类速度)' },
        amount: { type: 'number', description: 'scroll 每格滚轮档数, 默认 1' },
        direction: { type: 'string', enum: ['up', 'down'], description: 'scroll 方向, 默认 down' },
      },
      required: ['action'],
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      guard('desktop_mouse')
      const space = describeSpace(args.space)
      const req = { cmd: 'mouse', action: args.action, button: args.button, count: intOr(args.count, 1), amount: intOr(args.amount, 1), direction: args.direction || 'down', durationMs: intOr(args.durationMs, 0) }
      if (args.x !== undefined && args.y !== undefined) {
        const p = toScreen(args.x, args.y, args.space)
        req.x = p.x
        req.y = p.y
      }
      if (args.toX !== undefined && args.toY !== undefined) {
        const p = toScreen(args.toX, args.toY, args.space)
        req.toX = p.x
        req.toY = p.y
      }
      const res = await helper.run(req, { signal: exec?.signal, timeoutMs: 40000 })
      return {
        ok: true,
        action: res.action,
        cursor: res.cursor,
        space,
        ...(frame ? { cursorInImage: cursorInImage(res.cursor, frame.region, frame.scaleX, frame.scaleY) } : {}),
      }
    },
  })

  ctx.tools.register({
    name: 'desktop_keyboard',
    description:
      '键盘输入。action=type 逐字符打字 (支持中文/emoji, 走 Unicode 注入, 不会触发输入法候选), 默认约 18 字/秒并带人类节奏抖动;'
      + ' action=press 发送组合键 (key 可写 "ctrl+a" 或 keys:["ctrl","a"]), 支持长按 repeat 与 hold。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['type', 'paste', 'press', 'hold'], description: 'type=逐字打字, paste=粘贴 (长文本快, 会临时占用剪贴板后还原), press=按键/组合键, hold=长按' },
        text: { type: 'string', description: 'action=type/paste 时要输入的文字' },
        key: { type: 'string', description: '单个按键或组合, 如 "enter" / "ctrl+a"' },
        keys: { type: 'array', items: { type: 'string' }, description: '组合键数组, 如 ["ctrl","shift","t"]' },
        cps: { type: 'number', description: '打字速度 (字符/秒), 默认 18' },
        delayMs: { type: 'number', description: '每字符间隔 (毫秒), 覆盖 cps' },
        repeat: { type: 'number', description: '按键重复次数, 默认 1' },
        restoreClipboard: { type: 'boolean', description: 'paste 后还原原剪贴板内容, 默认 true' },
      },
      required: ['action'],
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      guard('desktop_keyboard')
      if (args.action === 'paste') {
        const res = await helper.run({
          cmd: 'paste',
          text: String(args.text ?? ''),
          restore: args.restoreClipboard !== false,
        }, { signal: exec?.signal, timeoutMs: 30000 })
        return { ok: true, action: 'paste', chars: res.chars }
      }
      let keys = Array.isArray(args.keys) ? args.keys.flatMap(splitCombo) : []
      if (args.key) keys = splitCombo(args.key)
      if (args.action === 'type' && typeof args.text !== 'string') throw new Error('action=type 需要 text')
      if (args.action !== 'type' && keys.length === 0) throw new Error('action=press/hold 需要 key 或 keys')
      const res = await helper.run({
        cmd: 'key',
        action: args.action,
        text: args.text || '',
        keys,
        delayMs: intOr(args.delayMs, 0),
        repeat: intOr(args.repeat, 1),
        cps: intOr(args.cps, 18),
      }, { signal: exec?.signal, timeoutMs: 120000 })
      return { ok: true, action: res.action, ...(res.chars ? { chars: res.chars } : {}), ...(res.keys ? { keys: res.keys } : {}) }
    },
  })

  ctx.tools.register({
    name: 'desktop_act',
    description:
      '在一个调用里按顺序执行一串界面操作, 最后截一张图回来看结果 —— 「看→点→打字→再看」合成一次调用, 比逐步调用省很多往返。'
      + ' steps 每项是一个对象: {op:"click"|"move"|"drag"|"scroll"|"type"|"paste"|"press"|"wait"|"focus"|"waitChange", ...}。'
      + ' 步骤坐标的取景规则: 传了 window/region/monitor 就按它算, 没传就沿用上一张截图的取景 —— 所以给的坐标和最后那张图总是同一套。'
      + ' 只有最后一张图回传 (不额外耗 token)。waitChange 会反复轻量截图直到画面变化或超时, 适合等页面/窗口加载完成。',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: '操作序列',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['click', 'right', 'double', 'move', 'drag', 'scroll', 'type', 'paste', 'press', 'wait', 'focus', 'waitChange', 'screenshot'] },
              x: { type: 'number' }, y: { type: 'number' },
              toX: { type: 'number' }, toY: { type: 'number' },
              space: { type: 'string', enum: ['image', 'screen'] },
              text: { type: 'string' },
              key: { type: 'string' },
              keys: { type: 'array', items: { type: 'string' } },
              window: { type: ['string', 'number'] },
              ms: { type: 'number' },
              amount: { type: 'number' },
              direction: { type: 'string', enum: ['up', 'down'] },
              durationMs: { type: 'number' },
              cps: { type: 'number' },
            },
            required: ['op'],
          },
        },
        capture: { type: 'boolean', description: '结束后是否截图, 默认 true' },
        maxWidth: { type: 'number' },
        quality: { type: 'number' },
        grayscale: { type: 'boolean' },
        showCursor: { type: 'boolean' },
        window: { type: ['string', 'number'], description: '要截的窗口 (默认截主屏)' },
        region: { type: 'object', properties: { left: { type: 'number' }, top: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } } },
        onlyIfChanged: { type: 'boolean' },
        stopOnError: { type: 'boolean', description: '默认 true' },
      },
      required: ['steps'],
    },
    output: IMAGE_OUTPUT,
    async execute(args, exec) {
      guard('desktop_act')
      const signal = exec?.signal
      const steps = Array.isArray(args.steps) ? args.steps : []
      const stopOnError = args.stopOnError !== false
      const log = []
      let failed = null

      // Fix the framing the steps are expressed in *before* touching anything:
      // an explicit target (window/region/monitor) wins, otherwise we inherit
      // the last screenshot's framing so step coordinates line up with the
      // final image instead of with some older stale frame.
      const hasTarget = args.region !== undefined || args.window !== undefined
        || args.monitor !== undefined || args.fullScreen === true
      const region = hasTarget || !frame
        ? await resolveRegion(args, signal)
        : frame.region
      frame = predictFrame(args, region)

      for (const step of steps) {
        if (signal?.aborted) throw new HelperError('命令已取消', 'ABORTED')
        const op = String(step.op || '').trim()
        guard(`desktop_act:${op}`)
        try {
          const entry = await runStep(op, step, signal)
          log.push(entry)
        } catch (e) {
          // An emergency stop is not a step failure: it must abort the whole
          // batch right here, never be recorded as "this step failed" and never
          // let the remaining steps or the trailing screenshot run.
          if (e?.code === 'HALTED') throw e
          log.push({ op, ok: false, error: e?.message || String(e) })
          failed = { op, error: e?.message || String(e) }
          if (stopOnError) break
        }
      }

      const wantCapture = args.capture !== false
      if (!wantCapture) return { ok: !failed, steps: log, ...(failed ? { failed } : {}) }

      const shotArgs = { ...args, region }
      if (args.onlyIfChanged === true && lastHash) {
        const { meta } = await capture(shotArgs, { signal, attach: false, track: false })
        if (meta.hash === lastHash) {
          return { ok: !failed, steps: log, unchanged: true, region: meta.region, ...(failed ? { failed } : {}) }
        }
      }
      const value = await shot(shotArgs, exec)
      return { ...value, ok: !failed, steps: log, ...(failed ? { failed } : {}) }
    },
  })

  // Mirror what the helper will produce for a region, so steps can be mapped
  // to screen coordinates without taking a real screenshot first.
  function predictFrame(args, region) {
    const maxW = Math.max(0, intOr(args.maxWidth, DEFAULTS.maxWidth))
    const maxH = Math.max(0, intOr(args.maxHeight, 0))
    let s = 1
    if (maxW > 0) s = Math.min(s, maxW / region.width)
    if (maxH > 0) s = Math.min(s, maxH / region.height)
    return {
      region,
      srcWidth: region.width,
      srcHeight: region.height,
      width: Math.round(region.width * s),
      height: Math.round(region.height * s),
      scaleX: s,
      scaleY: s,
      at: Date.now(),
      predicted: true,
    }
  }

  // Read-only safety status. Allowed even while halted — it is how the model
  // finds out that the human pulled the brake and how to say so.
  ctx.tools.register({
    name: 'desktop_guard',
    description:
      '查看紧急停止状态: 是否被用户用 Ctrl+Shift+C 拦截、热键是否注册成功、以及解除方式。'
      + ' 任何时候都能调用, 被拦截时也不会报错 (返回 halted=true)。'
      + ' 收到 HALTED 错误后想知道当前是否已解除, 就调它。',
    parameters: { type: 'object', properties: {} },
    output: TEXT_OUTPUT,
    async execute() {
      let running = true
      try { await helper.start() } catch { running = false }
      const h = helper.refreshHalt({ force: true })
      const level = running ? h.level : 0
      const registration = helper.hotkeys || { stop: null, resume: null }
      return {
        ok: true,
        halted: level > 0,
        level,
        meaning: level === 0
          ? 'AI 可以操作桌面'
          : level >= 2 ? '用户要求结束本次对话, 桌面控制已全部拦截' : '用户紧急停止, 桌面控制已全部拦截',
        hotkeys: {
          stop: 'ctrl+shift+c',
          escalate: 'ctrl+shift+c 之后按 v',
          resume: 'ctrl+shift+x',
          registration,
        },
        helperRunning: running,
        ...(level > 0 ? { note: haltMessage(level, h) } : {}),
      }
    },
  })

  ctx.tools.register({
    name: 'desktop_ocr',
    description:
      '把屏幕上的文字读成 JSON (文本 + 屏幕坐标), 不返回图片 —— 一次约 100 token, 一张截图约 15000。'
      + ' 想看界面上有哪些按钮/菜单/数值时优先用它; window/region 限定范围, 默认整个前台窗口。'
      + ' scale 1.5-2 可提高小字识别率。读屏优先级 L1: 没有文字(游戏图标/状态)就改用 desktop_find; 必须看懂视觉再上 desktop_screenshot。',
    parameters: {
      type: 'object',
      properties: {
        window: { type: ['string', 'number'], description: '要读的窗口 (标题子串或 hwnd), 默认前台窗口' },
        region: {
          type: 'object',
          description: '只读该屏幕区域 (物理像素)',
          properties: {
            left: { type: 'number' }, top: { type: 'number' },
            width: { type: 'number' }, height: { type: 'number' },
          },
        },
        scale: { type: 'number', description: '识别前放大倍数 1-3, 小字用 1.5-2; 默认 1' },
        lang: { type: 'string', description: '语言标签 (zh-Hans / en-US), 默认跟随系统' },
        minLength: { type: 'number', description: '丢掉短于该长度的行, 默认 1' },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      guard('desktop_ocr')
      const region = await resolveRegion(args, exec?.signal)
      const res = await helper.run({
        cmd: 'ocr',
        left: region.left,
        top: region.top,
        width: region.width,
        height: region.height,
        scale: Math.max(1, Math.min(3, Number(args.scale) || 1)),
        lang: args.lang ? String(args.lang) : '',
      }, { signal: exec?.signal, timeoutMs: 60000 })
      const minLen = Math.max(1, intOr(args.minLength, 1))
      const lines = (res.lines || []).filter((l) => String(l.t || '').trim().length >= minLen)
      return {
        ok: true,
        region: { left: region.left, top: region.top, width: region.width, height: region.height },
        engine: res.engine,
        count: lines.length,
        lines: lines.map((l) => ({ t: l.t, x: l.x, y: l.y, w: l.w, h: l.h })),
        coord: 'screen',
      }
    },
  })

  ctx.tools.register({
    name: 'desktop_find',
    description:
      '按颜色"看"屏幕, 只返回数字不返回图片 (几十到两百 token)。三种模式: '
      + 'find=找某种颜色的所有色块, 返回中心点列表 (找高亮格子/按钮/指示灯); '
      + 'grid=把区域切成 cols×rows 网格, 返回每格平均色 (快速判断布局); '
      + 'points=读若干坐标的颜色 (校验某点是否为绿色等)。',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['find', 'grid', 'points'], description: '默认 find' },
        window: { type: ['string', 'number'], description: '限定窗口 (标题子串或 hwnd)' },
        region: {
          type: 'object',
          description: '限定屏幕区域 (物理像素)',
          properties: {
            left: { type: 'number' }, top: { type: 'number' },
            width: { type: 'number' }, height: { type: 'number' },
          },
        },
        color: { type: 'string', description: 'find 用: #rrggbb' },
        tolerance: { type: 'number', description: 'find 用: 颜色容差, 默认 30' },
        minArea: { type: 'number', description: 'find 用: 最小色块面积 (px), 默认 40' },
        step: { type: 'number', description: 'find 用: 采样步长, 默认 2 (越大越快越粗)' },
        maxResults: { type: 'number', description: 'find 用: 最多返回几个, 默认 30' },
        points: {
          type: 'array',
          description: 'points 用: [{x,y}, ...] 坐标 (默认按最近截图的图像坐标, space=screen 时为屏幕坐标)',
          items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
        },
        cols: { type: 'number', description: 'grid 用: 列数, 默认 16' },
        rows: { type: 'number', description: 'grid 用: 行数, 默认 9' },
        space: { type: 'string', enum: ['image', 'screen'], description: 'points 坐标基准, 默认 image' },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      guard('desktop_find')
      const mode = ['find', 'grid', 'points'].includes(args.mode) ? args.mode : 'find'
      let region
      if (mode === 'points' && !args.region && (args.window === undefined || args.window === null || args.window === '')) {
        const lay = await layout(exec?.signal)
        region = { ...lay.virtualScreen }
      } else {
        region = await resolveRegion(args, exec?.signal)
      }
      const req = {
        cmd: 'probe',
        mode,
        left: region.left,
        top: region.top,
        width: region.width,
        height: region.height,
      }
      if (mode === 'points') {
        const space = describeSpace(args.space)
        const list = Array.isArray(args.points) ? args.points : []
        if (!list.length) throw new Error('points 模式需要 points: [{x,y}, ...]')
        req.points = list.map((p) => {
          const s = space === 'image' ? toScreen(p.x, p.y, 'image') : { x: intOr(p.x, 0), y: intOr(p.y, 0) }
          return `${s.x},${s.y}`
        }).join(';')
      } else if (mode === 'grid') {
        req.cols = intOr(args.cols, 16)
        req.rows = intOr(args.rows, 9)
      } else {
        if (!args.color) throw new Error('find 模式需要 color: "#rrggbb"')
        req.color = String(args.color)
        req.tolerance = intOr(args.tolerance, 30)
        req.minArea = intOr(args.minArea, 40)
        req.step = intOr(args.step, 2)
        req.maxResults = intOr(args.maxResults, 30)
      }
      const res = await helper.run(req, { signal: exec?.signal, timeoutMs: 30000 })
      const out = { ok: true, mode, region: { left: region.left, top: region.top, width: region.width, height: region.height } }
      if (mode === 'points') out.points = res.points || []
      else if (mode === 'grid') { out.cols = res.cols; out.rows = res.rows; out.grid = res.grid }
      else { out.total = res.total; out.matches = res.matches || []; out.coord = 'screen' }
      return out
    },
  })

  ctx.tools.register({
    name: 'desktop_click_text',
    description:
      '读屏上的文字并点击它: {text:"开始行动"} 一步完成"找字→算坐标→点击"。'
      + ' match=contains (默认) 或 exact; index 选第几个命中 (0 起); button 默认 left。'
      + ' 命中返回 clicked 与坐标, 没命中返回 candidates (可换成更短的关键词重试)。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要找的文字' },
        match: { type: 'string', enum: ['contains', 'exact'], description: '默认 contains' },
        index: { type: 'number', description: '第几个命中, 默认 0' },
        window: { type: ['string', 'number'], description: '限定窗口, 默认前台窗口' },
        region: {
          type: 'object',
          description: '限定屏幕区域 (物理像素)',
          properties: {
            left: { type: 'number' }, top: { type: 'number' },
            width: { type: 'number' }, height: { type: 'number' },
          },
        },
        scale: { type: 'number', description: 'OCR 放大倍数, 默认 1' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: '默认 left' },
        dryRun: { type: 'boolean', description: '只找不点' },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      guard('desktop_click_text')
      const needle = String(args.text || '').trim()
      if (!needle) throw new Error('需要 text')
      const region = await resolveRegion(args, exec?.signal)
      const res = await helper.run({
        cmd: 'ocr',
        left: region.left,
        top: region.top,
        width: region.width,
        height: region.height,
        scale: Math.max(1, Math.min(3, Number(args.scale) || 1)),
        lang: '',
      }, { signal: exec?.signal, timeoutMs: 60000 })
      const exact = args.match === 'exact'
      const hits = (res.lines || []).filter((l) => {
        const t = String(l.t || '').trim()
        return exact ? t === needle : t.includes(needle)
      })
      if (!hits.length) {
        return {
          ok: false,
          reason: 'text not found',
          text: needle,
          region: { left: region.left, top: region.top, width: region.width, height: region.height },
          candidates: (res.lines || []).slice(0, 25).map((l) => String(l.t || '').trim()),
        }
      }
      const hit = hits[Math.max(0, Math.min(hits.length - 1, intOr(args.index, 0)))]
      const x = Math.round(hit.x + hit.w / 2)
      const y = Math.round(hit.y + hit.h / 2)
      if (args.dryRun === true) return { ok: true, dryRun: true, hit: { t: hit.t, x, y, w: hit.w, h: hit.h }, hits: hits.length }
      await helper.run({
        cmd: 'mouse', action: 'click', button: args.button || 'left',
        count: 1, amount: 1, direction: 'down', durationMs: 0, x, y,
      }, { signal: exec?.signal, timeoutMs: 20000 })
      return { ok: true, clicked: String(hit.t || '').trim(), x, y, hits: hits.length, coord: 'screen' }
    },
  })

  ctx.tools.register({
    name: 'desktop_a11y',
    description:
      '读窗口的"无障碍控件树" (Windows UI Automation): 按钮/输入框/文本/菜单/标签页, 每项带名称与屏幕坐标, 一次约 150 token。'
      + ' 操作普通软件/浏览器/WPF/UWP 时这是最省的看懂方式, 拿到的坐标可直接点。'
      + ' 读屏优先级 L0: 读不到内容(只回 5 个节点)就改用 desktop_ocr / desktop_find。',
    parameters: {
      type: 'object',
      properties: {
        window: { type: ['string', 'number'], description: '窗口标题子串或 hwnd, 默认前台窗口' },
        maxDepth: { type: 'number', description: '最大层级, 默认 6' },
        maxNodes: { type: 'number', description: '最多返回多少个控件, 默认 160' },
        onlyNamed: { type: 'boolean', description: '只返回有名称的控件 (更省 token), 默认 true' },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      guard('desktop_a11y')
      let hwnd = 0
      let title = ''
      if (args.window !== undefined && args.window !== null && args.window !== '') {
        if (typeof args.window === 'number') hwnd = args.window
        else {
          const res = await helper.run({ cmd: 'window', action: 'info', title: String(args.window) }, { signal: exec?.signal, timeoutMs: 15000 })
          hwnd = Number(res.window?.hwnd) || 0
          title = res.window?.title || ''
          if (!hwnd) throw new Error(`找不到窗口: ${args.window}`)
        }
      }
      const res = await helper.run({
        cmd: 'a11y',
        hwnd,
        maxDepth: intOr(args.maxDepth, 6),
        maxNodes: intOr(args.maxNodes, 160),
        onlyNamed: args.onlyNamed !== false,
      }, { signal: exec?.signal, timeoutMs: 30000 })
      return {
        ok: true,
        window: title || res.window || '',
        count: res.count || 0,
        truncated: res.truncated === true,
        nodes: res.nodes || [],
        coord: 'screen',
        ...((res.count || 0) === 1
          ? { hint: '只读到窗口本身: 该界面不暴露控件 (自绘画布), 改用 desktop_find 或 desktop_ocr' }
          : {}),
      }
    },
  })

  async function runStep(op, step, signal) {
    const space = describeSpace(step.space)
    if (op === 'wait') {
      const ms = intOr(step.ms, 300)
      await sleep(ms)
      return { op, ok: true, ms }
    }
    if (op === 'focus') {
      const req = { cmd: 'window', action: step.action || 'focus' }
      if (typeof step.window === 'number') req.hwnd = step.window
      else req.title = String(step.window || '')
      // x/y/w/h are screen pixels here: window geometry, not mouse targets.
      for (const k of ['x', 'y', 'w', 'h']) if (step[k] !== undefined) req[k] = intOr(step[k], 0)
      const res = await helper.run(req, { signal, timeoutMs: 15000 })
      return { op, ok: true, action: req.action, window: res.window?.title, hwnd: res.window?.hwnd, rect: res.window?.rect }
    }
    if (op === 'screenshot') {
      const { meta } = await capture(step, { signal, attach: false, track: false })
      return { op, ok: true, hash: meta.hash.slice(0, 12), region: meta.region }
    }
    if (op === 'waitChange') {
      const timeoutMs = Math.min(60000, intOr(step.ms, 8000))
      const interval = Math.min(2000, Math.max(120, intOr(step.intervalMs, 350)))
      const base = (await capture(step, { signal, attach: false, track: false })).meta.hash
      const started = Date.now()
      let changed = false
      while (Date.now() - started < timeoutMs) {
        await sleep(interval)
        if (signal?.aborted) throw new HelperError('命令已取消', 'ABORTED')
        const h = (await capture(step, { signal, attach: false, track: false })).meta.hash
        if (h !== base) { changed = true; break }
      }
      return { op, ok: true, changed, waitedMs: Date.now() - started }
    }
    if (op === 'type') {
      const res = await helper.run({
        cmd: 'key', action: 'type', text: String(step.text ?? ''), keys: [],
        delayMs: intOr(step.delayMs, 0), repeat: 1, cps: intOr(step.cps, 18),
      }, { signal, timeoutMs: 120000 })
      return { op, ok: true, chars: res.chars }
    }
    if (op === 'paste') {
      const res = await helper.run({
        cmd: 'paste', text: String(step.text ?? ''), restore: step.restoreClipboard !== false,
      }, { signal, timeoutMs: 30000 })
      return { op, ok: true, chars: res.chars }
    }
    if (op === 'press' || op === 'hold') {
      let keys = Array.isArray(step.keys) ? step.keys.flatMap(splitCombo) : []
      if (step.key) keys = splitCombo(step.key)
      if (!keys.length) throw new Error(`${op} 需要 key 或 keys`)
      const res = await helper.run({
        cmd: 'key', action: op, text: '', keys,
        delayMs: intOr(step.delayMs, 0), repeat: intOr(step.repeat, 1), cps: 0,
      }, { signal, timeoutMs: 60000 })
      return { op, ok: true, keys: res.keys }
    }

    // mouse family
    const mouseOp = op === 'right' || op === 'double' || op === 'click' || op === 'move' || op === 'drag' || op === 'scroll'
      ? op : null
    if (!mouseOp) throw new Error(`未知 op: ${op}`)
    const req = {
      cmd: 'mouse', action: mouseOp, button: step.button || 'left',
      count: intOr(step.count, intOr(step.amount, 1)), amount: 1,
      direction: step.direction || 'down', durationMs: intOr(step.durationMs, 0),
    }
    if (step.x !== undefined && step.y !== undefined) {
      const p = toScreen(step.x, step.y, step.space)
      req.x = p.x
      req.y = p.y
    }
    if (step.toX !== undefined && step.toY !== undefined) {
      const p = toScreen(step.toX, step.toY, step.space)
      req.toX = p.x
      req.toY = p.y
    }
    const res = await helper.run(req, { signal, timeoutMs: 60000 })
    return {
      op: mouseOp, ok: true, space, cursor: res.cursor,
      ...(frame ? { cursorInImage: cursorInImage(res.cursor, frame.region, frame.scaleX, frame.scaleY) } : {}),
    }
  }

  // Live safety note. Empty while running (costs nothing), and the moment the
  // user hits the kill switch it is injected into the next request so the model
  // stops even if it is not calling a tool right now.
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    ctx.effect(() => systemPrompt.section({
      name: 'gui-control-safety',
      order: 2500,
      text: () => {
        const h = helper.refreshHalt()
        if (!h || h.level === 0) return ''
        return h.level >= 2
          ? '⛔ 用户已按下 Ctrl+Shift+C 后按 V 要求立即结束：桌面控制（鼠标/键盘/窗口/截图）已全部被拦截。'
            + '不要再调用任何工具，也不要继续当前任务；用一两句话确认已停手，把控制权交回用户。'
          : '⛔ 用户已按下 Ctrl+Shift+C 紧急停止：桌面控制（鼠标/键盘/窗口/截图）已全部被拦截。'
            + '不要调用 desktop_* 工具，向用户说明已停手并等待指示（用户按 Ctrl+Shift+X 解除）。'
      },
    }), 'dsh-gui-control: halt prompt section')
  }

  // Bundle the usage notes so the model can re-read them mid-task without
  // burning a tool call on every detail.
  try {
    const content = readFileSync(SKILL_PATH, 'utf8')
    if (content) {
      ctx.skills.register({
        name: 'gui-control',
        description:
          '用 desktop_* 工具看屏幕并像人一样操作鼠标键盘。'
          + ' 涉及截图分析界面、点击按钮、填表输入、连续观察界面变化、批量操作桌面时使用。',
        content,
        source: 'bundled',
      })
    }
  } catch (e) {
    ctx.logger?.warn?.('gui-control: skill 注册失败 (%s)', e?.message || e)
  }
}

function splitCombo(spec) {
  if (typeof spec !== 'string') return []
  const parts = spec.split('+').map((s) => s.trim()).filter(Boolean)
  return parts.length ? parts : []
}
