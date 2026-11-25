# 第 18 轮深度审查记录（2026-11-24 夜）

> 本轮目标：连续多轮深度代码审查 + UI 一致性/布局优化，按收益降序修完所有发现问题。
> 范围：渲染层 48 个工具页、`js/` 根模块、`css/app.css`、`ipc/` 与 `lib/` 中与本轮缺陷相关的路径。
> 约束：不跑实机交互（只跑仓库自带测试，其中部分 E2E 会自启 Electron）；不 push、不上传。

## 一、按收益排序的问题与修复

| 收益 | 问题 | 位置 | 处理 |
|---|---|---|---|
| P0 | 批量工具的「停止」按钮**从未解开**：整批处理期间一直是灰的，停止机制等于不存在 | `media/img-compress.js`、`img-watermark.js`、`batch-ocr.js` | 开工分支补 `*.disabled = false`，收尾回灰；新增 S1/S2/S3 回归断言 |
| P0 | 离开页面后 `running` 不复位：保活复用回来点「开始」被静默挡掉，表现为「工具坏了」 | `video-frames.js`、`audio-cut.js`、`img-watermark.js`、`img-batch.js` | cleanup 里复位 `running` / 按钮 / `picker.setLocked(false)`，状态行如实改写 |
| P0 | 批量任务没有 per-run 序号：切页回来立刻再点一次，旧轮 `cancelFlag` 被新一轮置回 false，**两轮并发写盘** | `img-batch.js`、`img-watermark.js`、`img-scramble.js`（选目录后才领序号） | 增加 `batchRunSeq` / `wmRunSeq`，循环与写盘前双检查，`finally` 只复位自己那一代；`img-scramble` 改为选目录**前**领序号并回检 |
| P0 | 批量改名可重入：两阶段改名会把第二轮指向临时名 | `file-tools.js`（batch-rename） | `guard` + 执行期间禁用「执行」；收尾按**当前冲突数**恢复，不再无条件解锁 |
| P0 | 批量改后缀可重入（过期 `plan` 再改一轮） | `file-tools.js`（batch-ext） | `guard` + 执行期间禁用按钮 |
| P0 | 「Unicode 转换」解码方向自加入起就是坏的（正则多写一层反斜杠；emoji 永不合并） | `text-codec.js` | 修正两条正则 + 注释；新增 `test-text-codec-unicode.js`（7 条，U1–U7 全 PASS） |
| P1 | 录屏「停止」后设置项仍可改：改麦克风不影响已开录的文件，改摄像头会抢设备并把提示刷成失败 | `media/screen-rec.js` | `setControlsLocked()`：录制期间锁帧率/音频/摄像头/区域/GIF；停止与离开解锁 |
| P1 | 剪贴板历史开关关闭后仍在采：`poll()` 在 await 返回后无条件重排定时器 | `security.js` | await 后先判 `watching` 再重排；两条分支都补 |
| P1 | 图片批处理编码完仍会多写一张：点停止/切页发生在编码期间时状态写「已停止」而磁盘多一个文件 | `img-batch.js`（本轮原已修一层） | 写盘前再判 `cancelFlag`/序号（本轮补序号维度） |
| P1 | `target-size` 每跑一次就往 `App.onCleanup` 里追加一个订阅闭包（按引用去重永远不会命中） | `target-size.js` | 页面级单槽 `avUnsub`，跑完/离开只释放当前那一条 |
| P1 | `env-manager` 安装中切页回来，`draw()` 重建按钮把 busy 态抹掉（看起来能点） | `env-manager.js` | `draw()` 末尾统一 `setBusy(busy)` |
| P1 | 便签搜索/标签/保存后每次都全量读盘（笔记一多输入发卡） | `text-tools.js`（local-notes） | 按 `path+size+mtime` 缓存正文与标签，删除/改名时清缓存 |
| P1 | 剪贴板历史图片文件不存在时仍提示「已复制」（剪贴板其实没变） | `security.js` | 读不到 dataURL 时 `warn` 并 return |
| P1 | `audio-cut`/`video-frames` 离开页面只递增序号，`running` 与按钮停留在「处理中」 | 两页 | cleanup 复位 running/按钮/状态行 |
| P1 | 快照工具条测试在 DPR≠1 时恒失败：竖着数 1px 列，size=1 与 size=10 都是整列纯红 | `scripts/test-snip-toolbar-ui.js` | 改为**横穿边框**数红色像素（实测约 2 vs 19），断言仍锁「线宽真的影响笔画」 |
| P2 | Markdown 预览「导出 HTML / 打开文件」失败是未处理 rejection，界面无提示 | `dev.js` | 两处加 try/catch + toast |
| P2 | 随机数字区间写反（下限>上限）时生成小于下限的数 | `dev.js` | 自动对调上下限 |
| P2 | 「打开系统还原」在 `rstrui` 探测为空时静默无反应 | `sys-tools.js` | 补 toast 说明系统未安装该组件及替代入口 |
| P2 | 二维码识别页 blob URL 未释放（整屏截图数 MB） | `media/screenshot-ocr.js` | `App.onCleanup(dropLastUrl)`；识别加 `ocrBusy` 防重入 + finally 复位 |
| P2 | 「打开链接」在识别结果不是 http(s) 时静默 | `qr.js` | toast + i18n 词表补英文 |
| P2 | 计算器历史卡、JSON 树形卡在没有内容时留空壳 | `convert.js`、`json-regex.js` | 按状态隐藏卡片 |
| P2 | `img-scramble` 开始处理可并发（各自选目录、互相 ++ 序号作废） | `media/img-scramble.js` | `guard` + 按钮全程禁用 |
| P2 | 音频容器（mp3/m4a/wav/flac）下仍可调视频编码/CRF/分辨率/帧率（调了也不生效） | `media/av-convert.js` | `refreshFmt()` 按目标格式置灰；标签「持续（秒）」→「时长」 |
| P3 | 命令面板整块不随语言变：English 下工具名英文、面板文案全中文 | `js/cmdk.js` | 动作名用 `nameEn`、占位符/空态/底栏/「命令」标签双语 |
| P3 | 批量改名收尾无条件 `applyBtn.disabled=false`，抹掉「名称冲突」提示态 | `file-tools.js` | 收尾改走 `syncApplyState(conflictIdx.size)` |
| P3 | `img-batch` 创建输出目录失败的早退没把停止按钮收回灰态 | `img-batch.js` | 两条失败路径补 `stopBtn.disabled = true` |

合计 **26 项**：P0 6、P1 9、P2 8、P3 3。

## 二、UI 一致性与布局优化（本轮实施）

1. **字号回归整数刻度**：清掉所有半像素字号（`13.5 / 12.5 / 11.5px`），CSS 与 JS 内联样式一并处理 —— 亚像素字号在不同缩放下会让同一行字粗细不一。
2. **圆角收口到 4/6/8/10 刻度**：`.input/.select/textarea` 5→6px（与 `.btn`、`.pane-ta` 一致）；相似图缩略图 5→6px；侧栏 logo 7→8px；工具头图标 9→10px；关于页图标 11→12px；搜索框小胶囊 5→4px。
3. **窄窗口栅格收口**：
   - `@media (max-width: 860px)`：`split-pane`（左/中按钮/右三栏）改为上下堆叠，中间按钮满宽 —— 720px 窗口下每栏不再被压到 200px 以下。
   - `@media (max-width: 820px)`：`.card` 内边距 24→18/16px，表单行间距 12→8px。
4. **死样式清理**：删除未使用的 `.tool-grid.cols-4`。
5. **命令面板双语化**（见上表 P3）。

## 三、新增/调整的测试

| 文件 | 内容 |
|---|---|
| `scripts/test-text-codec-unicode.js`（新） | 7 条：编码/解码往返（ASCII/中文/emoji/转义）、单值解码、普通文本不动、残缺 `\u12` 不改 |
| `scripts/test-round18-fixes.js`（新） | 18 条：停止按钮可点、清理复位、per-run 序号、订阅单槽、缓存失效、录制设置锁、格式置灰、批量改名防重入、blob URL 释放、编码后判定、CSS 刻度/断点、Unicode 正则单反斜杠 |
| `scripts/test-snip-toolbar-ui.js`（改） | 线宽测量改为横穿边框（DPR≠1 下仍能区分 1px / 10px） |
| `scripts/source-assertions-baseline.txt`（改） | `test-lan-scan.js` 的 B 由 1 收紧为 0（低于基线时如实收紧） |
| `scripts/test-restore-point.js`（改） | RP6 扫描窗口 4200→4700 字符（本轮给「打开系统还原」补提示后，删除入口被推出窗口；断言语义不变） |

## 四、验证记录

- `npx eslint js scripts`：0 问题。
- `npx tsc -p jsconfig.json`：exit 0。
- `npm test`（本轮最后一次改动之后）：**211 脚本 / 2374 PASS / 0 失败 / 7 环境跳过**，耗时 350.2s，exit 0。
  - 本轮开始时同一套测试为 209 脚本 / 2349 PASS（基线）；新增 2 个测试文件共 25 条，另修正 2 个既有测试（线宽测量、还原点窗口）。
- 断言基线：`npm run test:count:write` 已重拍，`total=2374`（211 文件），`check-assertion-count` exit 0。
- `npx eslint js scripts`、`npx tsc -p jsconfig.json`：修复完成后再跑一次，均 0。

## 五、明确没做的事（避免误读）

- 未做 Electron 实机点击验证：所有结论来自源码逐行阅读 + 仓库自带单测/E2E。涉及「手势、拖拽、真实 ffmpeg 输出」的行为仍建议实机复核。
- 未改 `d3827ef` 的提交说明（历史已推送，不改写）；本轮改动保持在工作区，未提交、未 push。
- `ipc/media-ffmpeg.js`（87KB）、`ipc/fs-ops.js`（72KB）、`ipc/dir-acl-links.js`（95KB）本轮只做了针对性抽查（shell 注入、路径唯一化、任务取消），未再逐行通读；这三块在 R16/R17 已通读并修复过。

## 六、遗留观察（未修，理由）

1. `image-dedup` 与 `img-scramble` 之外的只读扫描页没有 per-run 序号：旧轮最多多写一屏只读结果，不产生文件副作用，成本高于收益。
2. 剪贴板历史把图片 dataURL 直接存进 store：历史多时配置文件会变大。属产品取舍（保留原图 vs 省空间），未擅自改。
3. `chain.js` 工具链在跑长任务时切页只清进度行，不清 `running`：`finally` 必然复位，提前复位反而会让用户重入叠第二趟。
