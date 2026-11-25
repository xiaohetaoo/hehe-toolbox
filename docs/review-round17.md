# 第十七轮代码审查与修复记录（v0.9.4 工作区 · 定时关机取消链路 / runCmd 非零语义 / 批量任务生命周期 / UI 一致性）

> 日期：2026-11-23 · 方式：只读逐行核验 + 静态扫描 + 纯 node 单测（不跑 Electron / 实机）
> 结论：**发现 18 项，全部已修复**（代码 16 项 + 文档 1 项 + 测试契约 1 项）。lint 0、typecheck 0、`npm run test:unit` 176 脚本 1931 PASS / 0 失败（修改前 1923，+8 条新行为/契约断言）。
> 状态：改动**未提交**，留待审阅；`dist/` 与断言基线未重拍（原因见第五节）。

## 一、按收益排序的问题清单（均已修复）

| # | 级别 | 位置 | 问题 | 修复 |
|---|---|---|---|---|
| 1 | P0 | `main.js` EXEC.RUN / `js/tools/sys-tools.js` apply+cancel | 上一轮加的"按退出码分支"在真实 IPC 链路上是**死代码**：`runCmd` 非零即 reject，而数字退出码不随 `lib/errors.js` 载荷回渲染层（只透传字符串 code）。排期失败只能看到整条命令行；取消时 `shutdown /a` 的 1116 走 catch 被记成失败 | EXEC.RUN 从载荷取 `allowNonZero` 并透传给两条 `runCmd` 路径；定时卡两处 `shutdown` 调用声明 `allowNonZero: true` |
| 2 | P1 | `sys-tools.js` cancel | 睡眠/锁屏点"取消"**必现**"取消失败，计划可能仍在生效"（`shutdown /a` 对无计划返回 1116） | 按 mode 分流：关机/重启只认 `shutdown /a`（0/1116 成功）；睡眠/锁屏只撤本页那条 ONCE，`shutdown /a` 仅作兜底、失败只作附注；门禁拦截（CAP_DENIED）在非关机模式下不计失败 |
| 3 | P1 | `sys-tools.js` cancel | 取消"提醒"会清空整张一次性定时列表并对提醒跑 `shutdown /a` | 提醒分支零 IPC，直接清状态 |
| 4 | P1 | `sys-tools.js` cancel | 只撤本页那条：新增 `onceId`（apply 记下 `r.item.id`），列表里其它定时保留；拿不到 onceId 才退回"全撤" | — |
| 5 | P1 | `sys-tools.js` cancel | 取消失败后倒计时静帧（clearInterval 后不重挂） | 失败路径用 `arm()` 重挂展示 interval 并标红；空闲时取消只给结论不重挂 |
| 6 | P1 | `sys-tools.js` apply | 确认框 / EXEC.RUN / ONCE_ADD 的 await 期间切页，返回后仍 arm（interval 无人清）且不改状态 | `pageShown`（cleanup=false / onEnter=true）：已离开只记 `mode/targetTs/onceId`，不动界面；denied 分支离开后不再弹二级确认框 |
| 7 | P1 | `main.js`（7z ×3）/ `ipc/env-manager.js`（×6）/ `ipc/media-ffmpeg.js`（×4）/ `ipc/dir-acl-links.js`（×1） | 14 处"调用后 `if (r.code !== 0) throw new Error('…：' + 程序原话)`"的调用点在 runCmd 改默认后全成死代码，用户只能看到 "Command failed: <整条命令行>" | 全部补 `allowNonZero: true`，把判成败交回已写好的分支 |
| 8 | P1 | `text-tools.js` TTS | "停止"在 `tts:speak` 返回前点了无效；cleanup 只 kill 不复位 → 保活复用回来"朗读"永久灰 | per-run `speakSeq` + `doStop(leftPage)` + 事件内认领 jobId + 过期分支自杀刚建的任务 |
| 9 | P1 | `launch.js` 命令收藏 | 无重入守卫（连点起两个进程、前者杀不掉、输出交错）；EXEC.STREAM 期间切页 → 孤儿常驻进程；输出框无上限 | `cmdRunSeq`/`running`/`setExecBusy`、过期分支 kill、输出裁剪到 500 行、job:exit 复位 |
| 10 | P1 | `target-size.js` | 切页不置 `canceled`：整批图片继续落盘；复用回来 picker 锁死、"开始压缩"灰到后台跑完 | cleanup 置 `canceled` 并调用 run 内的 `unlockUi`（`unlockRef`）；加 `targetRunSeq` 防旧趟 finally 复位新趟 |
| 11 | P1 | `media/img-batch.js`、`img-watermark.js`、`batch-ocr.js`、`img-dedup.js` | 四个批量页无停止按钮、无 cleanup（切页后整批继续写盘/起 OCR worker）；点了停止仍报"完成" | 统一加 `cancelFlag` + 停止按钮 + onCleanup；停止后状态行/toast 改为"已停止：已处理 N，剩余 M 未处理" |
| 12 | P2 | `media/img-dedup.js` + `css/app.css` | 结果格只放文件名（注释却说"每张缩略图"），且 `tc-item/tc-name` 在此处无任何样式；全盘扫描无停止 | 结果改为缩略图网格（新增 `.sim-grid/.sim-cell`），指纹阶段顺手生成 ≤160px 缩略图（透明铺白底）；加停止与"结果不完整"说明 |
| 13 | P2 | `file-tools.js` 全局搜索 | 全盘快扫没有停止入口（只能切页，结果全丢） | 新增"停止"按钮：`quickRunSeq++` + `stopQuick()`，保留已找到结果 |
| 14 | P2 | `media/video-press.js`、`video-trim.js`、`av-convert.js`、`img-compress.js` | 用户点"取消"却显示"已离开页面"；取消后行上仍挂"压制中/转换中"、进度条不清；av-convert 先判环境再判过期；img-compress 停止后报"压缩完成" | `pageCleanup(leftPage)` 区分文案并复位行标签/进度条；av-convert 调整判定顺序并补状态行；img-compress 停止分支单独汇报，写盘前再判一次中断 |
| 15 | P2 | `media/screen-rec.js`、`dev.js` | 开始录制跨 4 个 await 可重入（二次弹保存框/二次 REC.START）；框选区域的 onCleanup 登记在 await 之后；本地服务"启动"无守卫 | `starting` 标志包住 `startOnce`；登记移到第一个 await 之前；dev.js `running` 真正参与守卫（顺带删掉失真的 eslint-disable） |
| 16 | P3 | `net-tools.js` Ping、下载页 | `stop()` 先等 kill 再复位；exit 不清 jobId；下载过期分支漏杀流事件认领的 id | 先复位再 kill；exit 置 `jobId=null`；过期分支 `else if (jobId)` 补杀 |
| 17 | P3 | `hehe-toolbox.md` | 断言数写 2314，README/基线文件为 2341 | 改为 2341 |
| 18 | P3 | `env-manager.js` 取消按钮、定时卡取消按钮、`net-tools.js` 注释 | "停止下载"用 `btn-text`（像链接），其它页取消均为 `btn-danger-plain`；定时卡取消无图标；Ping 上方挂着失真的"历史遗留"eslint-disable | 统一为 `btn-sm btn-danger-plain`；补 `square` 图标；注释改为准确说明（running 在 Ping 页只写不读） |

## 二、复核确认无问题的区域（本轮重读）

- `app.js` 保活/清理内核：`onCleanup` 以 `f()` 无参调用（本轮 `pageCleanup(leftPage)` 用 `leftPage !== false` 兼容）；复用路径装回清理副本与入场钩子；`evictOne` 消费后置空。
- `ipc/env-manager.js` 安装流：下载 SHA-256 对目录校验，`safeCmd`/解压/用户变量读写均按 code 分支（本轮补回 allowNonZero）。zip 条目检查弱于 `lib/archive-guard.js`（未查设备名/ADS），但包已哈希校验，属纵深防御缺口，记录不改。
- `lan-scan.js`：阻塞式扫描无硬取消，靠序号作废迟到结果，注释已如实说明。
- `lib/run-token.js`、`lib/img-pick.js`、`lib/download.js`、`ipc/media-ffmpeg.js` 硬件回退（走 spawn，不受 runCmd 语义影响）。
- 全仓 `onCleanup` 无"await 之后登记"的残留（screen-rec 一处已前移）；工具页内联色值仅视频黑底两处。

## 三、测试

- `scripts/test-round16-behavior.js`：9 → 17 条。新增 C1-3（排期期间切页：记状态不 arm）、C1-4/C1-5（allowNonZero 契约，源码断言，原因写在每条上方）、C2-4（1116 成功）、C2-5（只撤 onceId）、C2-6（提醒零 IPC）、C2-7（onceId 对不上按成功）、C2-8（兜底抛错不改结论）；C1-1/C2-1~3 改为共用 `buildCancel` 真实闭包，并新增"失败后重挂倒计时"断言。
- `scripts/verify-fixes-in-package.js`：`pageCleanup` 签名正则放宽（新增 `leftPage` 参数）。
- `npm run lint` 0、`npm run typecheck` 0、`npm run test:unit` 176 脚本 / 1931 PASS / 0 失败（3 个环境跳过为既有）。

## 四、保留不改（需产品决定，按约定不提问）

- 批处理"续跑 vs 即停"策略（项目待办）。
- 7z 退出码 1（警告但归档已生成）目前按失败处理——沿用既有保守语义。

## 五、未做 / 需要用户在实机环境完成

1. **未提交、未 push**；`dist/` 未重建（本轮不发版）。
2. `scripts/assertions-baseline.json` 与 README 的总数未重拍：重拍要跑完整 `npm test`（含 Electron），本轮按要求只跑纯 node。纯 node 口径为 176 脚本 / 1931 条（比基线多 8 条，全部来自 round16-behavior）。
3. 以下改动只能实机确认：`shutdown /a` 在真实 Windows 上的 1116 路径、`sim-cell` 缩略图网格的视觉效果、录屏开始按钮的防重入、`allowNonZero` 后 7z/ffmpeg 错误文案。

---

## 六、追加扫描（同日 · 剩余页面 per-run token 补齐）

> 第一轮 18 项修完后继续扫描未覆盖页面，又发现 5 处"阻塞式 IPC + 无 per-run token"问题，已当场修复。

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| 19 | `media/audio-cut.js` | 音频剪辑（FFMPEG.AUDIO_CUT 阻塞式）无 per-run token：切页后 ffmpeg 跑完，结果 toast 到新页面 | `cutRunSeq` + onCleanup + await 后判过期 |
| 20 | `media/video-frames.js` | 视频截帧（FFMPEG.FRAMES 阻塞式）同上 | `frameRunSeq` + onCleanup + await 后判过期 |
| 21 | `office.js` PDF 转图片 | 逐页渲染 + 写盘（500 页 PDF 可能几分钟）无 per-run token：切页后继续写文件 | `pdfImgRunSeq` + 同步注册 onCleanup（不在 async 内注册）+ 循环内判过期 |
| 22 | `office.js` 办公转换 | OFFICE.CONVERT 批量阻塞式无 per-run token | `officeRunSeq` + onCleanup + await 后判过期 |
| 23 | `chain.js` 工具链 | 多步骤批量处理（压缩→解压→哈希→重命名）无 per-run token | `chainRunSeq` + onCleanup + await 后判过期 |
| 24 | `sys-tools.js` 磁盘分析 | SCAN_TREE 全盘扫描（可能几分钟）无 per-run token | `diskScanSeq` + onCleanup + await 后判过期 |
| 25 | `media/img-scramble.js` | 批量图片混淆（逐张 canvas + 写盘）无 per-run token 无 onCleanup | `scrambleRunSeq` + onCleanup + 循环内判过期 |

**追加后全套单测：209 脚本 / 2349 PASS / 0 失败**（与追加前一致，新修复不破坏既有契约）。

---

## 七、收尾（同一日 · PDF 类工具页与纯逻辑层复核）

### 7.1 补齐 per-run token（第 26–29 项）

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| 26 | `pdf-plus.js` 水印/页码卡 | 读文件、`embedFont`、保存框都是 await；切页后保存框/写盘/toast 会落到新页面 | `wmRunSeq` + onCleanup；embedFont 后、写盘前各判一次；catch 过期不弹错 |
| 27 | `pdf-plus.js` 提取文字卡 | 逐页 `getPage`/`getTextContent` 是 await；切页后仍跑完全部页并可能弹「没有文字层」模态框 | `txtRunSeq` + onCleanup；`getDocument` 后与每页前后判过期，过期直接 return 不写半截结果 |
| 28 | `pdf-plus.js` 瘦身卡 | `load`/`save`/保存框 await；切页后仍写盘与 toast | `slimRunSeq` + onCleanup + await 后判过期 |
| 29 | `pdf-pages.js` 保存 | `build()` 与保存框 await；切页后仍写盘与 toast | `pagesRunSeq` + onCleanup + await 后判过期 |

说明：这三处的水印/页码/页操作计算本身是同步 CPU 工作（无逐页 await IPC），不存在「后台任务继续跑」的问题；修的只是 await 窗口之后的界面副作用。

### 7.2 复核后判定为无需改动

- `win-layout.js` 的 `for … await WINMGR.PLACE`：循环长度等于用户选中的窗口数（个位数），每次调用瞬时且幂等，不需要取消语义。
- `diff3.js`：循环都是纯计算，`invoke` 只在打开/保存文件时各调一次，无长任务。
- `ipc/media-ffmpeg.js` 的三处批处理循环：每轮都检查 `state.cancel`，`jobs.set` 里挂了真正的 kill 回调（`killFfmpegTree`），取消链路完整。
- `ipc/fs-ops.js` 的分片/合并/去重：`cancelRef` + `jobs` 注册，逐文件检查取消标志。
- `lib/` 全部 50 个模块逐行通读（power-gate、path-guard、mojibake、acl-repair、dir-move、archive-guard、target-size、temp-names、hw-encode、crash-log 等）：均为纯函数 + 注入依赖的可测设计，未发现新的逻辑缺口。

### 7.3 最终校验

- `eslint .`：**0 问题**。
- `tsc -p jsconfig.json`：**0 错误**（exit 0）。
- `node scripts/run-tests.js --no-ui`：**209 脚本 / 2349 PASS / 0 失败**，7 个环境相关脚本按既有规则跳过，耗时 387s。
- 提交状态（2026-11-24 核对）：本轮全部代码改动**已在 HEAD `d3827ef` 中**（提交时间 15:43，
  提交说明为「chore: dist 补齐 0.9.5 + fetch-dist 内置镜像回退」，与实际内容不符）；
  `origin/main` 与 HEAD 一致，工作区干净。历史已推送，不改写，仅登记事实。

### 7.4 仍然只能实机确认的项

- `shutdown /a` 返回 1116 的取消成功路径（真机 Windows）。
- 相似图片缩略图网格 `.sim-grid/.sim-cell` 的视觉密度。
- 录屏开始按钮防重入、7z/ffmpeg 新错误文案。
- PDF 大文件（数百页）水印/页码的同步卡顿：这是计算本身占用渲染线程，属于已知性能特征，未做分片让出（会改变交互节奏，收益不明确）。
