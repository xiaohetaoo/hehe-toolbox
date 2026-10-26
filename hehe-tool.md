# 核核工具箱 —— 交接文档

> 写给接手本项目的下一个会话/agent。读完这一份就能安全地改代码、跑测试、发版本。
> 当前版本 **0.0.7**（已发布 Release）· 92 个工具 / 10 个模块 · 仓库 https://github.com/xiaohetaoo/hehe-toolbox

---

## 1. 这是什么

Windows 桌面效率工具箱（Electron 33 + 原生 JS，无框架、无构建步骤）。左侧导航 + 标签页外壳，92 个工具按 10 个模块分组，全部实现于 `js/tools/*.js`，主进程能力在 `main.js`。

- **开发运行**：`npx electron .`
- **打包便携版**：`npm run dist` → `dist/hehe-toolbox-Portable-<版本>.exe`
- **安装版**：`npm run dist:installer`（支持 electron-updater 全量升级）
- 镜像已配好（.npmrc + package.json electronDownload），构建时无需额外环境变量；如失效再加：
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`

### 用户定的规矩（务必遵守）

1. **推送必须经用户明确许可**，不得自行 push；许可包含"顺带发 Release"。
2. **推送前必须升版本号**（package.json `version`），并更新 README 相关描述。
3. GitHub 资产统一用英文名 `hehe-toolbox-Portable-<版本>.exe`（中文资产名会被 GitHub 剥离）。
4. 用户明确拒绝过"命令面板"这类全局命令 UI，不要再提。

---

## 2. 目录结构与职责

```
main.js            主进程（~2600 行）：窗口/托盘/热键/单实例锁 + 全部 IPC 能力层
preload.js         contextBridge 暴露 window.hehe（invoke/on），渲染进程经 js/api.js 封装
index.html         主界面外壳
ruler.html         屏幕标尺（独立透明窗）
pin.html           贴图置顶窗
snip.html          区域截图+标注全屏覆盖窗（v0.0.7 新增）
js/api.js          IPC 封装：window.api.invoke（解包/抛错）、window.api.on（返回取消订阅函数）
js/ui.js           组件库（表格/弹窗/Toast/开关/拖拽/折线图…）
js/registry.js     工具注册表：MODULES(10) + register()；导航/搜索/首页全由它生成
js/app.js          外壳：路由/标签页/收藏/最近使用/设置页/事件路由
js/tools/*.js      15 个文件按模块分组实现工具（92 个 register 调用）
.github/workflows/ ci.yml（push/PR 语法检查+工具数≥90 守卫）、release.yml（v* 标签自动发版）
```

main.js 分区速查（行号会漂移，按注释搜）：
`app/window/store(193)` `dialog(219)` `fs(237)` `exec(692)` `network(756)` `system(942)` `ffmpeg(1151)` `Office(1544)` `右键菜单(1613)` `电池(1666)` `全局搜索(1680)` `屏幕录制(1928)` `内容搜索(2036)` `贴图窗(2084)` `窗口管理(2108)` `7z(2144)` `WiFi(2178)` `TTS(2197)` `服务电源(2225)` `下载(2252)` `截图标注(2269)` `检查更新(2355)` `周期任务(2392)` `7z预览(2454)` `笔记PDF(2476)` `剪贴板图片(2497)` `Win11右键(2506)` `lifecycle(2522)`

### IPC 约定（改代码前必读）

- 主进程统一用 `handle('ns:action', fn)`，返回 `{ok:true,data}` / `{ok:false,error}` 信封。
- 渲染进程只用 **`window.api.invoke(name, ...args)`**：它解包并把 error 抛异常（`.catch` 得用）。
  测试里不要直接用 `window.hehe.invoke`，它不解包。
- 主进程 → 渲染事件用 `send('事件名', payload)`；渲染侧 `window.api.on(名, fn)`，返回值是取消订阅函数（用完要调，否则泄漏）。
- 数据持久化：`storeGet/storeSet` → `%APPDATA%/hehe-toolbox/hehe-data.json`；笔记在 `notes/`，剪贴板图片在 `clip-img/`，ffmpeg 在 `bin/`。

### 新增一个工具

在对应 `js/tools/*.js` 里 `register({ id, name, module, keywords, desc, render })` 一行注册 + 写 render 函数即可自动进导航/搜索/收藏。CI 有工具数 ≥90 的守卫，删工具会挂。

---

## 3. 测试方法

### 冒烟 + 功能 E2E（v0.0.7 时的做法，共 11 项，FINAL PASS）

主进程 `whenReady` 里临时挂一个块（`HEHE_SMOKE` 门控），跑完 `app.exit(fail===0?0:3)`，提交前删除。要点：

```bash
HEHE_SMOKE=1 \
HEHE_TEST_DATA="C:\Users\...\Temp\hehe-test-data"   # 隔离 userData，绕过单实例锁、不动真实数据
HEHE_MEDIA_DIR="C:\Users\...\Temp\hehe-test-data\media" \
npx electron . > log 2>&1
```

- **隔离目录要包含 `bin/ffmpeg.exe`**，否则录制/压制类测试全部"未找到 ffmpeg"（从老测试目录拷 bin）。
- 用 `win.webContents.executeJavaScript(code, true)` 驱动界面；截图窗要打到 **snipWin.webContents** 上（不是主窗）。
- snip.html 暴露了 `window.__snipTest = { select(x,y,w,h), addShape({type,...}), setTool, finish(action), getSel }` 供程序化选区/标注/提交。
- 区域录制等交互：`snip:region` 事件回传到页面（`window.__recRegion`）。
- 断言注意宽容度：录屏暂停/恢复 = 分段 concat（每段含启动开销≈0.7s），2+2 秒的录制实际出 6~7 秒属正常，别写 3.5~6.5 的紧区间。
- 涉及模态对话框的功能要留后门：`notes:pdf` 支持可选 `outPath` 免保存对话框直写（自动化专用）。
- 网络类断言要考虑降级：GitHub 匿名 API 限流（60 次/时/IP）时 `update:check` 应抛"检查更新失败"，测试接受该分支。

### 手工看界面

`HEHE_SHOT=1`（8 秒后截图存 `diag-shot.png`）、`HEHE_OPEN=tool-a,tool-b`（依次打开工具页）两个环境变量门控还在 main.js 里，可直接用。

---

## 4. 发版流程（v0.0.7 起全自动）

1. 改代码 → `node -c main.js` 等语法检查 → **升 package.json version** → 更新 README → 本地 commit。
2. 经用户许可后 `git push origin main`（触发 ci.yml 语法检查+守卫）。
3. `git tag vX.Y.Z && git push origin vX.Y.Z` → release.yml 在 windows-latest 上 `npm ci` → `npm run dist` → **自动创建草稿 Release**并上传 `hehe-toolbox-Portable-X.Y.Z.exe`。
4. 核对草稿后发布。命令行发布（PATCH `draft:false`）注意：
   - **中文 body/name 必须写进 UTF-8 文件**，用 `curl --data-binary @file` 提交；内联 `-d '中文'` 会被 Git Bash 按 GBK 转码成非法 JSON（HTTP 400）。
   - PAT 存在 Windows 凭据管理器（`git:https://github.com`，用户 xiaohetaoo）。取法：
     `printf "protocol=https\nhost=github.com\n" | GCM_INTERACTIVE=never git credential fill | grep "^password=" | cut -d= -f2`
     配 `Authorization: token $TOKEN` 调用 api.github.com。**token 绝不写进任何文件/输出**。

历史版本：0.0.1 初版 → 0.0.2 标尺修复 → 0.0.3 图片压缩/视频压制 → 0.0.4 全局文件搜索 → 0.0.5 审查修复 → 0.0.6 新增 16 工具 → **0.0.7 截图标注/自动更新/CI/录制增强/剪贴板/周期任务/7z 预览/笔记 PDF**。

---

## 5. 踩过的雷（改相关代码前先看这里）

| 领域 | 坑 | 现状 |
|---|---|---|
| Shell | Git Bash 是 GBK 控制台：含中文/反斜杠的代码**用 Write 工具写文件或 node 脚本生成**，不要 heredoc/printf/内联 `-d '中文'` | 已形成习惯 |
| GitHub API | 匿名限流会返回 403/无 tag_name；`update:check` 已加 `r.ok` 检查 + 15s 超时，限流时明确报错 | 已修 |
| 凭据弹窗 | GCM 反复弹登录框 → `git config credential.interactive=false`（github.com） | 已修，别删 |
| 截图 | `desktopCapturer.getSources` 连续调用偶发永久挂起 → `captureDisplay` 8s 超时+重试 2 次 | 已修 |
| 录屏 | gdigrab 区域宽高**必须偶数**（yuv420p 限制），`rec:start` 已 `& ~1` 取偶 | 已修 |
| 录屏 | 暂停/恢复=分段录制 + concat demuxer `-c copy`；直出 GIF 走 palettegen/paletteuse 两段式 | 可用 |
| USN 搜索 | `USN_RECORD_V2` 布局：TimeStamp 在偏移 **32**，FileNameLength/Offset 在 **52/56/58**（老资料常写错成 44/48/50）。FSCTL_ENUM_USN_DATA(0x900B3) 输入须 24 字节 MFT_ENUM_DATA_V0，CreateFileW 共享模式 **3u** | 已按微软文档定案 |
| 7z | `7zip-bin` 的 7za.exe 需保持 asar 外打包（构建日志确认在 `app.asar.unpacked/node_modules/7zip-bin/`），7z 列表参数 `l -bd -slt -p<密码>` | 可用 |
| Office | 转 PDF 双引擎 LibreOffice / Office COM，机器上都没有时提示用户装 | 可用 |
| 打包 | 白屏=html 漏进 `build.files`；查 asar：`npx --yes @electron/asar list dist/win-unpacked/resources/app.asar`（输出是反斜杠路径如 `\snip.html`） | 已核 |
| 开发噪音 | 启动日志里 CSP Security Warning 是开发期正常现象，打包后消失，不用管 | 忽略 |
| 单实例 | 正式运行有单实例锁；测试必须 `HEHE_TEST_DATA` 隔离 userData，否则直接退出(exit 3) | 已形成做法 |

---

## 6. 后续路线（用户已认可的远期项）

1. **音视频高级编辑**（滤镜/字幕/剪辑时间轴）—— 规格书 Phase 4。
2. **插件系统 + CLI 模式** —— 工具注册已插件化，差外部加载与命令行入口。
3. **PDF 加密/签名**。
4. 小改进候选：便携版自更新目前是"下载新版 exe 并打开位置"（无静默替换，可做引导替换脚本）；`update:check` 可加 ETag 缓存进一步降低限流影响；录制支持摄像头画中画。

## 7. 快速排查

- 起不来 → `node -c main.js`；看是不是单实例锁（用 HEHE_TEST_DATA 隔离再试）。
- IPC 报错 → 渲染控制台 `CONSOLE_ERR:` 前缀（main.js 里已挂 console-message 转发）。
- 工具页空白 → registry 里 id 重复或 render 抛错（冒烟测试会打出出错 id 列表）。
- ffmpeg 相关功能全挂 → 检查 `userData/bin/ffmpeg.exe` 是否存在，或设置里的自定义路径。
