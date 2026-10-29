# dsh-gui-control
注意：
1.一定要看紧急停止部分，避免大肥鱼乱来终止不了
2.不要给deepseek更改该插件的机会，以免紧急终止失效
3.紧急停止失效了怎么办？拔网线和拉电闸总有一个适合你。
4.代码为ai核查，可能存在未发现的漏洞。
5.截图、OCR、无障碍树都会把**屏幕内容**（含密码框外的可见信息）送进模型上下文；`paste` 会临时读写你的剪贴板。别在敏感界面上让它看屏幕。

> 给 DeepSeek Harness 装的「眼睛 + 手」：模型可以截图看屏幕、按画面里的坐标移动/点击鼠标、
> 打字敲键盘，并把「看 → 点 → 打字 → 再看」合成一次工具调用。

**版本 0.1.0** · Windows only · Node ≥ 18 · 零依赖 · MIT

---

## 目录

- [特性](#特性)
- [工具](#工具)
- [读屏优先级](#读屏优先级l0--l4)
- [紧急停止](#紧急停止)
- [坐标系](#坐标系)
- [实现](#实现)
- [安装](#安装)
- [配置](#配置)
- [本地测试](#本地测试)
- [已知边界](#已知边界)

## 紧急停止

| 热键 | 效果 |
| :--- | :--- |
| **Ctrl+Shift+C** | 刹车。所有桌面控制立刻失效 |
| **Ctrl+Shift+C+V** | 刹车 + 要求 AI 结束对话 |
| **Ctrl+Shift+X** | 解除 |

按下 Ctrl+Shift+C 后，正在打的长文本、正在跑的鼠标轨迹会在几十毫秒内中断（helper 在逐字符、
逐帧的循环里检查开关），之后每次调用都返回 `HALTED`，并且「用户已紧急停止」同时写进工具错误和
系统提示词，模型没有绕路可走。

再按 V 之后，文案变成「确认停手、把控制权交回用户、不要再调用任何工具」。

热键由 helper 里的专用线程用 `RegisterHotKey` 抢注（线程级消息队列），与窗口焦点无关；
状态写在一个小 JSON 文件里，Node 侧每次调用前读它，所以不用轮询进程。**解除只能由用户按键，
没有任何工具能让 AI 自己解开。（应该吧）**

---

## 特性

| | |
| :--- | :--- |
| **类人输入** | 鼠标轨迹不是瞬移，是三次贝塞尔曲线 + 缓动 + 抖动 + 落点修正，像人一样移过去再点 |
| **省 token 的读屏** | 同一块画面，「读」它的代价差 5~20 倍。四档读屏手段，从控件树到截图逐级加价 |
| **截图即压缩** | 默认宽 1280 / JPEG 质量 68；可限窗口、限区域、转灰度、变更检测 |
| **急停** | Ctrl+Shift+C 一按，所有桌面控制立刻失效，模型没有绕路可走 |
| **零依赖** | 只用 Node 内置模块和系统自带 PowerShell 5.1，不编译 exe |

同时注册了一个 `gui-control` skill，把坐标换算、省 token 策略、常见坑写进了模型上下文。

---

## 工具

### 读屏

| 工具 | 层级 | 作用 | 典型代价 |
| :--- | :---: | :--- | :--- |
| `desktop_a11y` | **L0** | Windows UI Automation 控件树：按钮/输入框/文本/菜单，每项带名称与屏幕坐标 | 5 个节点 ≈ 80 token<br>30 个 ≈ 550 |
| `desktop_ocr` | **L1** | 把屏幕文字读成 JSON（文本 + 屏幕坐标），不返回图片 | 窗口级 90~300<br>整屏 900~1100 |
| `desktop_find` | **L2** | 按颜色「看」屏幕，只回数字：`find` 找色块 / `grid` 摸布局 / `points` 校验某点 | `points` ≈ 15<br>`find` ≈ 30~80 |
| `desktop_screenshot` | **L3 / L4** | 截图并回传图像（可限窗口 / 区域 / 灰度 / 网格 / 变更检测） | 小图 300~800<br>大图 1,500~4,000 |

### 操作

| 工具 | 作用 |
| :--- | :--- |
| `desktop_info` | 显示器 / DPI / 光标 / 前台窗口 / 窗口列表。纯文本，不耗图像 token |
| `desktop_mouse` | `move` / `click` / `right` / `double` / `drag` / `scroll`，默认类人轨迹 |
| `desktop_keyboard` | `type`（逐字符 Unicode）/ `paste`（剪贴板秒贴）/ `press`（组合键）/ `hold` |
| `desktop_act` | 一串操作 + 末尾截图，一次调用完成多步交互；含 `waitChange` 等画面变化 |
| `desktop_click_text` | 读屏找字并点击：`{text:"开始行动"}` 一步完成「找字 → 算坐标 → 点击」；支持 `dryRun` |

### 守卫

| 工具 | 作用 |
| :--- | :--- |
| `desktop_guard` | 查看紧急停止状态（被拦截时唯一还能调通的工具） |

---

## 读屏优先级（L0 → L4）

**永远按 L0 → L4 往上试，第一级成功就停止，并在本会话内记住这个应用该用哪一级。**

| 级 | 手段 | 适用 | 失效信号 |
| :---: | :--- | :--- | :--- |
| **L0** | `desktop_a11y` | Win32 / WinForms / WPF / UWP、对话框、资源管理器、设置页 | `count <= 1`、没有目标控件名、`rect` 宽高为 0 |
| **L1** | `desktop_ocr` | 常规字号 UI 文字、菜单、报错、聊天记录 | `count === 0`、关键词没命中、坐标落在窗口外 |
| **L2** | `desktop_find` | 高亮态、按钮色、指示灯、血条、「红/绿/黄」状态 | `total: 0`、色块数量差一个量级、网格分不出目标 |
| **L3** | `desktop_screenshot` 小图 | 需要看懂图标语义、布局、视觉状态 | 看不清按钮/文字 |
| **L4** | `desktop_screenshot` 大图 | 读小字、像素级比对、OCR 兜底 | 没有更贵的了 |

**经验法则**

- 同一应用连续两次升级 → 这界面不适合当前手段，直接跳 L3，别在 L0/L1 反复试。
- 某级成功后，本会话内该应用**直接用那一级**。
- Electron/Chromium 应用（VSCode、DSH 本体）控件树只给外壳的 5 个节点 → 走 L1。
- 游戏 / Unity / 自绘 canvas → L2 找颜色，比看图便宜一个量级。
- 「这个值变了没有」「按钮点亮没有」→ `desktop_find` 的 `points`，比截图便宜 100 倍。

---

## 紧急停止

| 热键 | 效果 |
| :--- | :--- |
| **Ctrl+Shift+C** | 刹车。所有桌面控制立刻失效 |
| **Ctrl+Shift+C+V** | 刹车 + 要求 AI 结束对话 |
| **Ctrl+Shift+X** | 解除 |

按下 Ctrl+Shift+C 后，正在打的长文本、正在跑的鼠标轨迹会在几十毫秒内中断（helper 在逐字符、
逐帧的循环里检查开关），之后每次调用都返回 `HALTED`，并且「用户已紧急停止」同时写进工具错误和
系统提示词，模型没有绕路可走。

再按 V 之后，文案变成「确认停手、把控制权交回用户、不要再调用任何工具」。

热键由 helper 里的专用线程用 `RegisterHotKey` 抢注（线程级消息队列），与窗口焦点无关；
状态写在一个小 JSON 文件里，Node 侧每次调用前读它，所以不用轮询进程。**解除只能由用户按键，
没有任何工具能让 AI 自己解开。**

---

## 坐标系

模型只能看见图，所以**鼠标工具默认吃最近一张截图的像素坐标**：

```
screenX = region.left + imageX / scale.x
```

`desktop_screenshot` 返回 `region`（这张图对应的屏幕物理像素矩形）和 `scale`（图宽 ÷ 屏幕宽）。
每张新截图刷新这个坐标系；要直接用物理坐标时传 `space: "screen"`。

---

## 实现

```
index.js              插件入口：10 个工具 + 截图/坐标系/附件回传/急停守卫
lib/helper.js         helper 进程客户端（JSON 行协议、串行队列、超时、重启、急停状态）
helper/win-helper.ps1 Windows 后端：PowerShell 5.1 + 内嵌 C#（user32/gdi32 P/Invoke、热键线程）
skill.md              给模型的用法说明
test/*.mjs            脱离 DSH 的本地冒烟测试
```

**要点**

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

---

## 安装

```bash
# 在 DSH 里（plugin_manager 工具）；把路径换成你本机 clone 的位置
plugin_manager install_bundle  target=file:<你的路径>/dsh-gui-control
```

例如：

```bash
plugin_manager install_bundle  target=file:D:/code/dsh-gui-control
```

装好后重启 DSH，`desktop_*` 十个工具和 `gui-control` skill 就会出现。

> **改了代码之后**
>
> `install_bundle` 是把 `package.json` 的 `files` 列表**拷进** profile 的
> `node_modules/dsh-gui-control/`，不是软链。所以改完要重新 install（或直接 copy 覆盖过去），
> 再重启 DSH —— `disable → enable` 只重新 apply，不会重新 import 模块（ESM 缓存）。
>
> 只改了 `helper/win-helper.ps1` 的话不用重启：杀掉 helper 进程
> （`Get-CimInstance Win32_Process | ? { $_.CommandLine -like '*win-helper.ps1*' } | Stop-Process -Force`），
> 下次调用会自动拉起并读到新脚本。

---

## 配置

| 项 | 默认 | 说明 |
| :--- | :--- | :--- |
| `helperPath` | 包内 `helper/win-helper.ps1` | helper 脚本路径 |
| `powershell` | `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` | PowerShell 可执行文件 |
| `timeoutMs` | 60000 | 单条 helper 命令超时 |

环境变量 `DSH_GUI_CONTROL_KEEP_DIR`：设置后每张截图另存一份到该目录（调试用，正常不需要）。

---

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

---

## 已知边界

- **UAC / 安全桌面**下截图是黑的、`SendInput` 无效 —— 需要人来点。
- **最小化窗口**截不到内容（DWM 不合成），先 focus 还原。
- **窗口截图是「屏幕上那块区域」**，被别的窗口盖住就会截到盖住它的窗口。
- **锁屏时**无法操作。
- **急停热键只在 helper 启动后生效**（本会话第一次调用 `desktop_*` 就会拉起它，约 1 秒）。
  如果别的程序已经全局占用了 Ctrl+Shift+C，注册会失败，`desktop_guard` 的
  `hotkeys.registration.stop` 会是 false。

---

## 安全模型

这一节是自审结论，方便你判断它能不能装。

**不会执行 shell。** helper 的命令来自 Node 经 stdin 传入的一行 JSON，PowerShell 侧
`switch ($cmd)` 分发到 C# 静态方法，参数逐个 `[int]` / `[string]` / `[bool]` 转型。
代码里没有 `Invoke-Expression`、`cmd.exe`、`Start-Process`、COM 对象或任何把用户输入
拼进脚本的地方——打字内容走 `SendInput` 的 UNICODE 路径，不经过 shell 解析。

**不提权。** 全程以当前用户权限运行。目标窗口是管理员权限时 `SendInput` 会被系统拒绝，
helper 会明确报错而不是静默失败。

**资源上限。** 区域参数在 Node 侧 `clampRegion()` 里夹到单边 ≤ 16384、总面积 ≤ 4 MiB
（约 419 万像素，即 2048×2048），`desktop_find` 的 `points` 最多 2000 个；C# 的 `Grab()`
用同一个 `MaxGrabPx` 上限再挡一次——任何一条路径都不会向 GDI 申请巨图。

**急停优先于一切。** `Guard()` 在截图前、鼠标按下前、每个字符前都会检查，所以长任务
也能在几毫秒内停下；`Ctrl+Shift+C` 的两次升级和解除都只在 helper 进程内的独立线程里，
没有任何工具接口能让模型自己解除拦截。

**已知的信任边界**（不是漏洞，但你该知道）：

- 超时（默认 60s）只让 Node 侧放弃等待，helper 里那条命令仍会跑完。极长的 `type`
  超时后，后续命令可能在它还在打字时开始。需要绝对串行时把 `timeoutMs` 调大。
- 截图 / OCR / 无障碍树的输出都会进入模型上下文，等于把屏幕内容交给模型服务商。
- `paste` 会读一次你的剪贴板用于还原（`restoreClipboard: false` 则不读也不还原）。
- 急停热键注册失败而退化成轮询时，`Ctrl+Shift+C` 仍会传递给前台程序。

