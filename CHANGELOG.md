## 0.3.0

### 新增：低成本读屏（不传图也能"看见"）
- `desktop_ocr` —— 调 Windows 自带 OCR（Windows.Media.Ocr），把区域读成 `{t,x,y,w,h}` 文本行，一次约 100 token（同尺寸截图约 15000）。坐标已换算回屏幕像素，可直接点。
- `desktop_find` —— 像素探测三模式：`find` 找某颜色的色块中心点（找高亮格子/按钮/指示灯）、`grid` 返回 cols×rows 网格平均色、`points` 读指定坐标颜色。一次 50~200 token。
- `desktop_click_text` —— "找字→算坐标→点击"一步完成，`match` 可选 contains/exact，`dryRun` 只找不点。
- helper 新增 `probe` 与 `ocr` 命令；C# 侧新增 `DshProbe`（BitBlt + LockBits 取像素、连通域找色、SavePng 供 OCR 用），OCR 在 PowerShell 侧用 WinRT 调 `OcrEngine`。

### 修正
- OCR 行坐标原先取 `OcrLine.BoundingRect`（本机恒为 0），改为对 `line.Words[].BoundingRect` 求并集。
- 中文 OCR 会在字间插空格（"旧 应 用"），输出前按 CJK 相邻规则压缩空格。

# CHANGELOG

## 0.2.0

紧急停止体系，外加两个实测暴露出来的真 bug 的修复。

### 新增

- **Ctrl+Shift+C 急停**：helper 内独立线程 `RegisterHotKey`，与窗口焦点无关；抢注失败退化成
  30ms 按键轮询，多开也拦得住。状态写 `%TEMP%\dsh-gui-control\halt-<pid>.json`，Node 侧读文件。
- **Ctrl+Shift+C → V 二次拦截**：2.6s 窗口内再按 V 升级为「要求 AI 结束对话」。
- **Ctrl+Shift+X 解除**：只能人工按，没有任何工具能让 AI 自己解开。
- 三层拦截：C# 逐帧/逐字符 `Guard()`、Node 每次工具入口 `assertRunning()`、系统提示词实时注入。
- `desktop_guard` 工具：被拦截时唯一还能调通的只读状态查询。
- `gui-control` skill 里写明「收到 HALTED 不要重试、不要绕路」。

### 修复

- `desktop_act` 把急停异常当成「单步失败」，吞掉后继续跑后续步骤和尾部截图，
  导致报错标签错成 `screenshot`、批次不中断。现在 `HALTED` 直接冒泡终止整批。
- `desktop_guard` 未拦截时返回 `note: undefined`，触发 `value is not lossless JSON`。
- 步骤坐标误用上一张截图的取景（传了 `window:` 却按旧 frame 换算），新增 `predictFrame` 预判缩放。
- 急停异常文本被 PowerShell 包了一层，`startsWith('HALTED')` 判断失效，改正则 `\bHALTED:`。

## 0.1.0

首个可用版本：`desktop_info` / `desktop_screenshot` / `desktop_mouse` / `desktop_keyboard` /
`desktop_act`，PowerShell 5.1 + 内嵌 C# 后端（GDI 截图、SendInput 输入、三次贝塞尔类人轨迹），
图像经 DSH `attachments` 服务回传。
