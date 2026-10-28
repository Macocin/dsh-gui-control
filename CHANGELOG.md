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
