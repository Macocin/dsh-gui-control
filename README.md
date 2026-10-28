# dsh-gui-control

给 DeepSeek Harness 装的「眼睛 + 手」：模型可以截图看屏幕、按画面里的坐标移动/点击鼠标、
打字敲键盘，并把「看 → 点 → 打字 → 再看」合成一次工具调用。

鼠标轨迹不是瞬移，是三次贝塞尔曲线 + 缓动 + 抖动 + 落点修正，像人一样移过去再点。
截图默认就压缩过（宽 1280 / JPEG 质量 68），并且可以按窗口、按区域、转灰度、变更检测，
用来省图像 token。

## 工具

| 工具 | 作用 |
| --- | --- |
| `desktop_info` | 显示器/DPI/光标/前台窗口/窗口列表。纯文本，不耗图像 token |
| `desktop_screenshot` | 截图并回传图像（可限窗口/区域/灰度/网格/变更检测） |
| `desktop_mouse` | move / click / right / double / drag / scroll，默认类人轨迹 |
| `desktop_keyboard` | type（逐字符 Unicode）/ paste（剪贴板秒贴）/ press（组合键）/ hold |
| `desktop_act` | 一串操作 + 末尾截图，一次调用完成多步交互；含 `waitChange` 等画面变化 |
| `desktop_guard` | 查看紧急停止状态（被拦截时唯一还能调通的工具） |

同时注册了一个 `gui-control` skill，把坐标换算、省 token 策略、常见坑写进了模型上下文。

## 紧急停止

**Ctrl+Shift+C** = 刹车。按下后所有桌面控制立刻失效：正在打的长文本、正在跑的鼠标轨迹
会在几十毫秒内中断（helper 在逐字符、逐帧的循环里检查开关），之后每次调用都返回
`HALTED`，并且「用户已紧急停止」同时写进工具错误和系统提示词，模型没有绕路可走。

**Ctrl+Shift+C 之后再按 V** = 刹车 + 要求 AI 结束对话：文案变成"确认停手、把控制权交回
用户、不要再调用任何工具"。

**Ctrl+Shift+X** = 解除。

热键由 helper 里的专用线程用 `RegisterHotKey` 抢注（线程级消息队列），与窗口焦点无关；
状态写在一个小 JSON 文件里，Node 侧每次调用前读它，所以不用轮询进程。解除只能由用户
按键，没有任何工具能让 AI 自己解开。

## 坐标系

模型只能看见图，所以**鼠标工具默认吃最近一张截图的像素坐标**：

```
screenX = region.left + imageX / scale.x
```

`desktop_screenshot` 返回 `region`（这张图对应的屏幕物理像素矩形）和 `scale`（图宽 ÷ 屏幕宽）。
每张新截图刷新这个坐标系；要直接用物理坐标时传 `space: "screen"`。

## 实现

```
index.js              插件入口：6 个工具 + 截图/坐标系/附件回传/急停守卫
lib/helper.js         helper 进程客户端（JSON 行协议、串行队列、超时、重启、急停状态）
helper/win-helper.ps1 Windows 后端：PowerShell 5.1 + 内嵌 C#（user32/gdi32 P/Invoke、热键线程）
skill.md              给模型的用法说明
test/*.mjs            脱离 DSH 的本地冒烟测试
```

要点：

- **零依赖**。只用 Node 内置模块和系统自带的 PowerShell 5.1；不编译 exe（避免杀软误报）。
- **持久进程**。helper 启动时 `Add-Type` 编译一次 C# 桥，之后每条命令走 stdin/stdout 一行 JSON，
  单次调用约 50–90ms；首次含编译约 1s。
- **急停**由 helper 里一条独立线程守：`RegisterHotKey` 抢注 Ctrl+Shift+C / Ctrl+Shift+X
  （线程级消息队列，和窗口焦点无关）；抢不到就退化成 30ms 轮询按键状态，保证多开时也拦得住。
  状态写在 `%TEMP%\dsh-gui-control\halt-<pid>.json`，Node 每次调用前读它，不轮询进程。
- **截图**走 GDI `BitBlt(SRCCOPY|CAPTUREBLT)` 抓 DWM 合成后的桌面，所以 Chromium/Electron 窗口也能截到；
  进程声明 PER_MONITOR_AWARE_V2，坐标就是物理像素。
- **输入**走 `SendInput`：鼠标绝对坐标按虚拟桌面 65535 归一化（多显示器负坐标也对），
  文本用 `KEYEVENTF_UNICODE` 逐字符注入，中文/emoji 不经过输入法。
- **图像回传**用 DSH 的 `attachments` 服务（`ctx.get('attachments')` → `saveImage`），
  工具 `render` 返回 `[{type:'text'}, {type:'image', attachment}]`；服务缺失或超限时降级成文本 + 错误说明。
- helper 进程随插件 `ctx.effect` 清理；父进程退出时 stdin 关闭，helper 自己退出。

## 安装

```bash
# 在 DSH 里（plugin_manager 工具）
plugin_manager install_bundle  target=file:H:/DeepSeek Harness/dsh-gui-control
```

装好后重启 DSH，`desktop_*` 六个工具和 `gui-control` skill 就会出现。

> **改了代码之后**：`install_bundle` 是把 `package.json` 的 `files` 列表**拷进** profile 的
> `node_modules/dsh-gui-control/`，不是软链。所以改完要重新 install（或直接 copy 覆盖过去），
> 再重启 DSH —— `disable → enable` 只重新 apply，不会重新 import 模块（ESM 缓存）。
> 只改了 `helper/win-helper.ps1` 的话不用重启：杀掉 helper 进程
> （`Get-CimInstance Win32_Process | ? { $_.CommandLine -like '*win-helper.ps1*' } | Stop-Process -Force`），
> 下次调用会自动拉起并读到新脚本。

## 配置

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `helperPath` | 包内 `helper/win-helper.ps1` | helper 脚本路径 |
| `powershell` | `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` | PowerShell 可执行文件 |
| `timeoutMs` | 60000 | 单条 helper 命令超时 |

环境变量 `DSH_GUI_CONTROL_KEEP_DIR`：设置后每张截图另存一份到该目录（调试用，正常不需要）。

## 本地测试

```bash
node test/smoke.mjs           # 工具注册 + info/截图/移动/批量
node test/input.mjs           # 打开记事本, 聚焦, 打字(中文), 截图, 关闭
node test/click.mjs           # 按截图坐标点击 + 长文本粘贴
node test/framing.mjs         # act 步骤坐标跟随本次取景目标的断言
node test/halt.mjs            # 真按 Ctrl+Shift+C / +V / Ctrl+Shift+X, 断言全工具被拦与恢复
node test/halt-midflight.mjs  # 打字中途按急停, 断言 1.5s 内中断
```

这些脚本用假的 DSH context 直接跑插件，不需要重启 DSH；急停相关的两个会真的发全局热键。

## 已知边界

- UAC / 安全桌面（Secure Desktop）下截图是黑的、`SendInput` 无效 —— 需要人来点。
- 最小化窗口截不到内容（DWM 不合成），先 focus 还原。
- 窗口截图是「屏幕上那块区域」，被别的窗口盖住就会截到盖住它的窗口。
- 电脑锁屏时无法操作。
- 急停热键只在 helper 已经启动后生效（本会话第一次调用 desktop_* 就会拉起它，约 1 秒）。
  如果别的程序已经全局占用了 Ctrl+Shift+C，注册会失败，`desktop_guard` 的
  `hotkeys.registration.stop` 会是 false。
