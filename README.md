# 核核工具箱 (HeHe Toolbox)

> 本地优先 · 模块化 · 轻量启动 · 无广告 · 不收集隐私
> 基于《万能桌面工具箱 需求规格说明书（含UI设计规范·蓝色主题版）》实现的 Windows 桌面效率工具箱。

![tech](https://img.shields.io/badge/Electron-33-165DFF) ![theme](https://img.shields.io/badge/主题-商务科技蓝%20%23165DFF-165DFF)

## 快速开始

```bash
npm install        # 首次安装依赖（已配置 npmmirror 镜像）
npx electron .     # 启动应用
```

> 若首次安装后提示 "Electron failed to install correctly"，执行：
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`

## 功能总览（10 大模块 · 92 个工具）

| 模块 | 工具 |
|---|---|
| **系统与硬件** | 硬件信息总览（含电池健康度）、实时状态监控、进程管理、开机自启管理、右键菜单管理、Win11 经典右键一键切换、窗口管理（置顶/透明度）、服务与电源计划、定时任务（关机/提醒 + 每日·循环周期任务持久化：定时提醒/自动垃圾清理）、磁盘空间分析、垃圾清理、空目录清理、系统快捷操作 |
|  **文件处理** | 哈希校验（MD5/SHA1/SHA256/SHA512）、批量重命名、批量改后缀、文件加密解密（AES-256）、文件分割合并、重复文件查找、压缩解压（ZIP）、全局文件搜索（Everything 式秒搜：NTFS 索引 / es.exe / 快速扫描）、文件内容搜索（grep 式流式）、7z 压缩包（密码/分卷 + 不解压预览目录/大小/属性） |
| **文本与编码** | Base64、URL 编解码、Unicode、HTML 实体、Hex/ASCII、进制转换（BigInt）、时间戳、文本批量处理、文本统计、大小写转换、简繁转换（OpenCC）、CSV/JSON 互转、本地笔记（Markdown+全文搜索+标签分类+导出 PDF）、文本朗读（本地 TTS，可导出 WAV） |
| **网络运维** | 网络信息查询、Ping 测试（曲线/丢包率）、路由追踪、端口占用查询（一键结束）、端口连通测试、本机端口扫描、Hosts 编辑（备份还原）、网速测试 、WiFi 密码查看、文件下载（断点续传）|
| **开发调试** | JSON 格式化（树形查看）、正则测试、颜色转换器、屏幕取色器、屏幕坐标拾取、随机生成器、科学计算器、单位换算、HTTP 客户端、本地静态服务器、二维码生成、二维码识别 |
| **多媒体处理** | 图片批量处理（缩放/旋转/转格式/压缩）、图片水印、长截图拼接、EXIF 查看（含清除）、FFmpeg 环境（一键下载/手动导入）、音视频信息查看、音视频格式转换（H.264/H.265/MP3/GIF，批量队列+进度）、截图 OCR（tesseract 本地识别中英文）、图片压缩（智能/目标体积/指定质量，前后对比）、视频压制（H.264/H.265 预设瘦身）、屏幕录制（全屏/框选区域、麦克风录入、**摄像头画中画（四角可选·大小可调）**、暂停恢复分段拼接、直出 GIF）、视频截帧、批量图片 OCR、音频剪辑（淡入淡出/增益）、相似图片查找（dHash）、贴图置顶（Snipaste 式）、**区域截图+标注**（框选/矩形/箭头/画笔/文字/马赛克，一键复制/保存/贴图/OCR） |
| **办公文档** | PDF 合并/拆分/提取/旋转、图片转 PDF、PDF 转图片、Word/Excel/PPT ↔ PDF（LibreOffice / Office COM 双引擎）、Markdown 预览、文档对比、翻译、文档预览（PDF/TXT/MD/Office） |
| **安全与密码** | 密码生成器、密码强度检测、剪贴板历史（文本+图片条目、置顶、搜索） |
| **快捷启动** | 快捷启动栏（软件/文件夹/网址）、命令收藏（CMD/PowerShell）、全局搜索（Ctrl+K）、工具收藏 |
| **生活辅助** | 番茄钟/倒计时、日历与农历、便签待办、屏幕标尺 |

**外部引擎说明**：FFmpeg（音视频三件套）支持「FFmpeg 环境」工具一键下载（gyan.dev / BtbN 源）或手动导入 exe；OCR 使用 tesseract.js 本地引擎，语言包首次联网下载后永久离线可用；Office 互转自动检测 LibreOffice 与 Microsoft Office（COM）。剩余规划：音视频高级编辑（滤镜/字幕）、插件系统与 CLI 模式（规格书 Phase 4）、PDF 加密/签名。

## 设计规范落实

- **主题**：商务科技蓝 `#165DFF`（悬停 `#0E42D2` / 点击 `#0A34A5` / 浅蓝辅助 `#E8F3FF`），深色模式主色自动切换为 `#4080FF`
- **布局**：左侧导航 220px（深蓝灰 `#0F172A`，可收起至 64px）+ 顶部 48px 功能栏（面包屑/全局搜索/窗口控制）+ 多标签页内容区 + 24px 状态栏（CPU/内存实时，阈值变色）
- **交互**：200ms 页面淡入、卡片悬停上浮、Toast 顶部滑入、模态弹窗、危险操作红色按钮二次确认
- **窗口**：无边框自绘标题栏，默认 1000×660，支持最小化到托盘、全局热键唤起（默认 `Alt+Shift+H`）

## 架构

```
main.js            主进程：窗口/托盘/全局热键 + IPC 能力层
                   （文件系统、哈希/加密、进程、网络、系统信息、静态服务器…）
preload.js         contextBridge 安全暴露 API
js/
  api.js           IPC 封装（浏览器演示模式自动降级）
  ui.js            组件库（表格/弹窗/Toast/开关/拖拽区/折线图…）
  registry.js      工具注册表（插件化：新增工具一行注册，自动进导航+搜索）
  app.js           外壳：路由/标签页/收藏/最近使用/设置页
  tools/*.js       按模块分组的工具实现
```

- 配置与数据保存在 `%APPDATA%/hehe-toolbox/hehe-data.json`（收藏、最近使用、剪贴板历史、便签、快捷项、命令收藏），全部本地存储。
- 所有联网功能（公网 IP、翻译、测速）仅在用户主动点击时发起。

## 打包发布

```bash
npm run dist             # 单文件便携版 → dist/hehe-toolbox-Portable-0.0.8.exe（双击即用）
npm run dist:installer   # 安装版 → dist/核核工具箱 Setup 0.0.8.exe
```

- 便携版双击运行，无需安装；首次启动需解压到临时目录（约 1-2 秒）
- 配置与数据保存在 `%APPDATA%\hehe-toolbox`，与开发版共享，便携版/安装版/开发版数据互通
- `dist/win-unpacked/` 为免解压绿色目录版（启动更快）
- 重新构建需设置镜像：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ npm run dist`

## 自动更新与 CI

- **检查更新**：设置页「关于」一键检查。安装版走 electron-updater（NSIS 全量升级）；便携版查询 GitHub Releases 最新版，检测到新版本后内置下载（进度显示），下载完成可点「🚀 重启并替换」自动覆盖程序文件并拉起新版（配置与数据不受影响）；也可手动打开所在目录自行替换。查询带 **ETag 条件请求 + 6 小时本地缓存**，正常使用几乎不消耗 GitHub 匿名限流配额；缓存过期且网络失败时会明确报错并提示已知最新版本。
- **CI**：push / PR 自动做全量语法检查 + 工具注册数（≥90）守卫；推送 `v*` 标签自动在 Windows 构建便携版并创建**草稿 Release**（人工核对后发布）。
- 托盘右键菜单可直达常用工具：截图标注、贴剪贴板图片、记事、OCR 剪贴板图片等。
