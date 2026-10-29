# CHANGELOG

本项目的所有重要变更都记录在这里。

## 0.1.0

首个公开发布版本。在此之前的功能开发与修复已合并记录于本条下。

### 读屏（不传图也能"看见"）

- `desktop_screenshot` —— 截主屏 / 窗口 / 区域 / 虚拟桌面，可缩放、灰度、叠加光标与坐标网格；
  图像经 DSH `attachments` 服务回传，超限自动降级。
- `desktop_ocr` —— 调 Windows 自带 OCR（`Windows.Media.Ocr`），把区域读成 `{t,x,y,w,h}` 文本行，
  一次约 100 token（同尺寸截图约 15000）。坐标已换算回屏幕像素，可直接点。
- `desktop_a11y` —— 读窗口的无障碍控件树（Windows UI Automation）：控件类型 / 名称 / 屏幕坐标，
  一次约 150 token。Win32 / WPF / UWP / 浏览器可用；Unity 自绘画布读不到（改用 `desktop_find`）；
  Electron / Chromium 窗口默认只暴露外壳，要读内容得开系统无障碍或改用 `desktop_ocr`。
- `desktop_find` —— 像素探测三模式：`find` 找某颜色的色块中心点、`grid` 返回 cols×rows 网格平均色、
  `points` 读指定坐标颜色。一次 50~200 token。
- `desktop_info` —— 显示器 / DPI / 光标 / 前台窗口，不耗图像 token。
- helper 新增 `probe` 与 `ocr` 命令；C# 侧 `DshProbe`（BitBlt + LockBits 取像素、连通域找色、
  `SavePng` 供 OCR 用），OCR 在 PowerShell 侧用 WinRT 调 `OcrEngine`。

### 操作

- `desktop_mouse` —— 移动 / 点击 / 右键 / 双击 / 拖拽 / 滚轮，三次贝塞尔 + 缓动 + 抖动的类人轨迹，带落点修正。
- `desktop_keyboard` —— 逐字符 Unicode 注入打字（不吃输入法）、粘贴（临时占用剪贴板后还原）、
  单键 / 组合键 / 长按。
- `desktop_act` —— 一次调用跑一串步骤（点 / 移动 / 拖 / 滚 / 打字 / 粘贴 / 按键 / 等待 / 聚焦 /
  waitChange），最后只回一张图。「看→点→打字→再看」合成一次往返。
- `desktop_click_text` —— "找字→算坐标→点击"一步完成，`match` 可选 contains / exact，`dryRun` 只找不点。

### 急停

- **Ctrl+Shift+C 急停**：helper 内独立线程 `RegisterHotKey`，与窗口焦点无关；抢注失败退化成
  30ms 按键轮询，多开也拦得住。状态写 `%TEMP%\dsh-gui-control\halt-<pid>.json`，Node 侧读文件。
- **Ctrl+Shift+C → V 二次拦截**：2.6s 窗口内再按 V 升级为「要求 AI 结束对话」。
- **Ctrl+Shift+X 解除**：只能人工按，没有任何工具能让 AI 自己解开。
- 三层拦截：C# 逐帧 / 逐字符 `Guard()`、Node 每次工具入口 `assertRunning()`、系统提示词实时注入。
- `desktop_guard` 工具：被拦截时唯一还能调通的只读状态查询。
- `gui-control` skill 里写明「收到 HALTED 不要重试、不要绕路」。

### 开发期间修掉的问题

- `desktop_screenshot` / `desktop_ocr` 的区域参数没有上限，`{width:100000, height:100000}`
  会让 helper 直接向 GDI 申请几十 GB。Node 侧现在夹到单边 ≤ 16384、总面积 ≤ 4 MiB，
  C# 的 `Grab()` 用同一个上限再挡一次（纵深防御）。
- Node 侧的上限写成 4 MiB（4,194,304），C# 的 `DshProbe` 却按 4,000,000 判，
  结果正好卡在两数之间的请求会被 C# 拒绝。两边统一到 `MaxGrabPx = 4194304`。
- `paste` 的剪贴板还原拿的是 `Clipboard.GetDataObject()` 返回的**活动代理**，
  一旦 `SetText` 覆盖剪贴板，代理就取不到数据，还原后剪贴板变成空白。
  改成 `SnapshotClipboard()`：把每种格式的数据物化进独立的 `DataObject` 再还原。
- `desktop_find` 的 `points` 数量没有上限，改为最多 2000 个。
- helper 的 `#send` 超时分支只删了 pending、没摘掉 `abort` 监听器，改为统一 `cleanup()`。
- `desktop_act` 把急停异常当成「单步失败」，吞掉后继续跑后续步骤和尾部截图，
  导致报错标签错成 `screenshot`、批次不中断。现在 `HALTED` 直接冒泡终止整批。
- `desktop_guard` 未拦截时返回 `note: undefined`，触发 `value is not lossless JSON`。
- 步骤坐标误用上一张截图的取景（传了 `window:` 却按旧 frame 换算），新增 `predictFrame` 预判缩放。
- 急停异常文本被 PowerShell 包了一层，`startsWith('HALTED')` 判断失效，改正则 `\bHALTED:`。
- OCR 行坐标原先取 `OcrLine.BoundingRect`（本机恒为 0），改为对 `line.Words[].BoundingRect` 求并集。
- 中文 OCR 会在字间插空格（"旧 应 用"），输出前按 CJK 相邻规则压缩空格。
