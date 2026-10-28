# 桌面控制 (gui-control)

你有五个工具可以直接看屏幕、动鼠标、敲键盘：`desktop_info` / `desktop_screenshot` /
`desktop_mouse` / `desktop_keyboard` / `desktop_guard`，外加把一串操作合成一次调用的 `desktop_act`。

## 坐标系（最重要，先读这段）

截图是屏幕的缩放副本。`desktop_screenshot` 返回里有两样东西：

- `region`：这张图对应屏幕上的物理像素矩形 `{left, top, width, height}`
- `scale.x/y`：图宽 ÷ 屏幕宽（`maxWidth: 1280` 截 1920 宽屏时是 0.6667）

**鼠标工具默认吃「最近一张截图里的像素坐标」**，也就是你在图上直接量到的位置，
插件自己按 `region + scale` 换算回屏幕。所以：

- 看到按钮在图上 (860, 320) → `desktop_mouse {action:"click", x:860, y:320}`
- 想用屏幕物理坐标（比如 `desktop_info` 给的光标位置）→ 传 `space:"screen"`

每张新截图都会刷新这个坐标系。切了窗口/换了区域就重新截一张再点。

## 紧急停止（用户随时可能按下）

用户按 **Ctrl+Shift+C** 会立刻拦截你所有桌面控制（鼠标/键盘/窗口/截图），正在进行的
打字或移动也会在几十毫秒内中断。此后每次调用都返回 `HALTED` 错误并附带说明。

- 收到 `HALTED`：**不要重试、不要绕路**，向用户说明已停手，等指示。
- 想知道是否已解除：调 `desktop_guard`（唯一在被拦截时也能调通的工具）。
- 用户按 **Ctrl+Shift+X** 才解除；按 **Ctrl+Shift+C 之后再按 V** 表示「直接结束这次对话」，
  这时要用一两句话确认停手，不要再调用任何工具。

## 省 token 的截图策略

| 情况 | 参数 |
| --- | --- |
| 一般界面操作 | 默认即可（宽 1280 / JPEG 68 / 光标准星）|
| 只关心某个窗口 | `window: "记事本"`（标题子串）或 `window: <hwnd>` |
| 只关心一块区域 | `region: {left,top,width,height}` |
| 读文字、表格、代码 | `grayscale: true`，必要时提高 `quality` |
| 要精确坐标 | `grid: true` 叠加 100px 网格，网格线标的是**屏幕坐标**，读到的数字配 `space:"screen"` 用 |
| 轮询等变化 | `onlyIfChanged: true`，画面没变就只回 `unchanged`，不发送图像 |
| 全屏多显示器 | `fullScreen: true`（一般不要，图会很大）|

不要用 `maxWidth: 0` 看整屏原图，除非确实需要读小字；一张 1920 宽的彩色截图约是
1280 宽版本的 2 倍图像 token。

## 类人操作

鼠标动作不是瞬移：走三次贝塞尔曲线 + easeInOut 缓动 + 抖动，落点再精确修正一次，
总耗时按距离自适应（约 170–750ms）。这就是默认行为，不用额外要求。

键盘 `action:"type"` 走 Unicode 注入，中文/emoji 不走输入法候选框，默认约 18 字/秒
并带人类节奏抖动。几百字以上的长文本用 `action:"paste"`（写剪贴板 → Ctrl+V →
还原剪贴板），200ms 完成。快捷键用 `press` + `key:"ctrl+a"`。

## 标准流程

1. `desktop_screenshot`（拿画面和坐标）
2. 想清楚要点哪里 → `desktop_act` 把「移动/点击/打字/回车/等待」串起来，末尾自动截一张
3. 看返回的图确认结果；不对就修正坐标重来，不要盲目连点

`desktop_act` 的 `steps` 示例：

```json
{"steps":[
  {"op":"click","x":640,"y":60},
  {"op":"type","text":"dsh gui control"},
  {"op":"press","key":"enter"},
  {"op":"waitChange","ms":8000}
]}
```

`waitChange` 会每 350ms 轻量截一帧比对哈希，直到画面变化或超时 —— 等页面加载、
等弹窗出现用它，比反复手动截图便宜得多。

## 常见坑

- **坐标偏了**：多半是用了物理坐标却按截图坐标传。检查 `scale`；或先
  `desktop_screenshot` 再点。
- **点不动**：窗口没在前台。用 `desktop_act` 的 `{"op":"focus","window":"标题"}`
  或 `desktop_info` 确认 `foreground.title`。
- **输入没反应**：焦点不在输入框。点击输入框后再 type；也可 `press` 一次 `tab`/`esc`
  试探焦点。
- **UAC / 安全桌面**：弹权限确认框时会切到 Secure Desktop，截图是黑的、SendInput 无效。
  这种情况需要人处理，别硬试。
- **最小化窗口**：截不到内容（DWM 不合成）。先 `desktop_act {"op":"focus",...}` 还原。
- **隐私**：截图会把整屏内容送给模型，涉及密码/隐私页面时先用 `window`/`region`
  限制范围，或干脆问用户要不要继续。
