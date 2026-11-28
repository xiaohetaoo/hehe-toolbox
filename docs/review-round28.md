# 第 28 轮：页面保活长任务复位 + 异步换文件竞态

本轮从 2026-11-27 23:12 起，目标至少 5 小时；只做静态代码审查与自动化门禁，不手工启动应用做实机验收，不派子代理。所有改动留在工作区，未 `commit`、未 `push`。

## 修复（按收益降序）

### R28-1 磁盘分析：离开/返回后扫描入口不再永久锁死

`js/tools/sys-tools.js` 的磁盘分析页会被 `App` 保活复用。旧实现只在 cleanup 里 `diskScanSeq++`，但：

- `busy` 仍是 `true`，返回页面后点「开始分析」直接静默返回；
- 旧扫描的 `finally` 无条件 `busy=false / prog.hide()`，页面上还留着「扫描中…」；
- 旧 `job:progress` 没有序号过滤，晚到的进度会写进新一轮的状态行。

现在：

- cleanup 作废当前结果、隐藏进度；若扫描在飞，明确写「已离开页面，上一轮分析会在后台收尾」并保持按钮禁用；
- `onEnter` 在旧扫描未结束时保持禁用并提示「仍在后台收尾」，结束后由 `finally` 恢复；
- `finally` 无论是否当前趟都恢复 `busy/按钮/进度条`，但只有当前趟才写结果；旧趟只把「收尾中」改成「已完成，可重新开始」；
- 进度监听先判 `runToken !== diskScanSeq`，旧事件整条丢弃；
- 双击时 `busy` 分支给「正在分析，请稍候」提示，而不是静默。

### R28-2 PDF 页面管理：换文件时旧读取晚到不能覆盖新文档

`js/tools/pdf-pages.js` 的 `onChange` 会连续换文件，`READ_FILE_B64` 与 `PDFDocument.load` 两个 `await` 之间没有序号。A 的读取比 B 慢时，A 的 `doc/pageOrder` 会覆盖 B，界面显示 B 却对 A 操作。

现在：

- 新增 `loadSeq`，每次 `loadDoc()` 领号；两个 `await` 之后各判一次，旧结果直接丢；
- 两个 `await` 都过了才一次性提交 `srcB64/doc/pageOrder`，失败不会留下半更新现场；
- `onChange` 先清掉旧文档状态，加载期间操作按钮被 `null` 判据拦住；
- `reset()` 和页面 cleanup 都 `loadSeq++`，取消选择/离开页面也能作废在飞读取。

### R28-3 压缩包预览：换包后旧 LIST 结果不能覆盖新包

`js/tools/file-tools.js` 的「预览（不解压）」用 `7z l` 读大包可能几秒。原来 `listArchive()` 直接写可变 `pvPath.p`，换包后旧结果晚到会覆盖新包内容。

现在：

- 每次换包 `pvSeq++`，`listArchive` 捕获本次 `archive` 路径与序号；
- LIST 返回后 `mySeq !== pvSeq || pvPath.p !== archive` 直接丢弃；
- 「列出内容」按钮会收到 `MouseEvent`，用 `typeof seqToken === 'number'` 区分，避免把事件对象当序号导致永远不显示。

### R28-4 文档预览：转换期间换文件不能把新文件塞进旧流程

`js/tools/office.js` 的 Office 预览有 LibreOffice 转换、PDF 渲染多个 `await`。`previewRun` 原来是每次读可变的 `filePath`，用户在转换期间换文件，旧请求会去转换新文件，预览框和选择器错位。

现在 `previewRun` 开头 `const target = filePath`，PDF/TXT/Office 三条分支与 `OFFICE.CONVERT` 全部使用 `target`。

### R28-5 空目录扫描：双击不会并发两趟递归扫描

`js/tools/sys-tools.js` 的 `SCAN_EMPTY_DIRS` 会递归整棵目录树。原按钮没有占闸，双击会并发两趟，后一趟覆盖 `dirs`，删除按钮可能拿着半截列表去删。

现在 `scanningDirs` 闸 + `scanBtn.disabled`，进入 `try` 前占闸，`finally` 必复位；重复点击提示「正在扫描，请稍候」。

### R28-6 PDF 水印/提取/瘦身：处理期间换文件不能把 A 内容存成 B 名

`js/tools/pdf-plus.js` 三个处理页都有读文件、生成、保存框等 `await`，默认文件名原来读可变的 `pdfPath`。A 处理到一半用户换 B，A 的内容会被保存成 `B-stamped.pdf` / `B-slim.pdf`。

现在三个入口都在开头 `const srcPath = pdfPath`，读取与默认文件名统一使用 `srcPath`。

### R28-7 屏幕坐标页：4 个数字块在窄工具窗自动落列

`js/tools/dev.js` 原来是 `repeat(4, 1fr)`；560px 工具窗内容区约 500px，去掉 gap 后每列只剩 ~100px，「X (物理像素)」标签会换行，四个数字块高低不齐。

改为 `repeat(auto-fit, minmax(120px, 1fr))`：宽窗仍是 4 列，560px 自动落成 3 列，第四块换行。

### R28-8 网络实时速率：5 个指标在窄窗自动落列

`js/tools/net-tools.js` 的实时速率区原来是 `repeat(5, minmax(0, 1fr))`，560px 窗里每列约 90px，速率/累计流量显示会挤成窄柱。

改为 `repeat(auto-fit, minmax(100px, 1fr))`：窄窗落成 4 列，宽窗仍是一排 5 个。

### R28-9 同一个 zip 重复拖入不再并发解压到同一目录

`js/tools/file-tools.js` 的「解压 ZIP」选择器是「选到就解压」。同一个 zip 连续触发会并发写同一个 `-extracted` 目标目录；用全局 busy 又会把用户换另一个包也挡掉。

现在按**目标目录**占闸：`unzipDirs` 集合里有同目录就提示「这个压缩包正在解压」，不同包可以并行；`finally` 释放。

### R28-10 三栏 diff：列允许收缩，长行不撑破页面

`js/tools/diff3.js` 的 `44px 1fr 1fr 1fr` 里 `1fr` 默认 `min-width:auto`，超长行会把三栏撑出容器。表头与数据行都改为 `44px minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)`，列内断行生效。

## 回归测试

新增 `scripts/test-round28-fixes.js`，10 条：

- R28-01 磁盘分析 cleanup/onEnter/进度序号/finally 恢复；
- R28-02 PDF 页面管理 `loadSeq` 与提交前两次判断；
- R28-03 压缩包预览 `pvSeq`、旧结果丢弃、按钮事件对象识别；
- R28-04 文档预览捕获 `target`；
- R28-05 空目录扫描防重入；
- R28-06 PDF 三个处理页捕获 `srcPath`；
- R28-07 坐标页 4 个数字块窄窗自动落列；
- R28-08 实时速率 5 个指标窄窗自动落列；
- R28-09 同一个 zip 重复拖入按目标目录拦截；
- R28-10 diff3 三栏 `minmax(0,1fr)` 防止长行撑破。

## 门禁

- `npm run lint`：0
- `npm run typecheck`：0
- 完整 `test:count:write`：**225 脚本 / 2555 PASS**，`scripts/assertions-baseline.json` 已重拍；7 个环境脚本跳过
- `test-source-assertions`：6 条 PASS；源码断言 **1784**，其中 **1320** 条已写「锁的是」
- `test-i18n-assertions`：227 条 PASS
- `test-pdf-pages.js` 10 条 PASS、`test-round16-behavior.js` 17 条 PASS、`test-round25-fixes.js` 26 条 PASS、`test-round28-fixes.js` 10 条 PASS

## 范围

- 未手工启动应用做交互验收；自动化测试中的 Electron 用例按仓库既有门禁执行。
- 未派子代理；`dist/`、`docs/copyright/` 未触碰。
- 仍未修：R24-45 更新路径口径分叉、R24-51 `jsconfig` 覆盖缺口、`HOSTS.BACKUP` 真实 hosts 写入实测、560px 工具窗截图复核、`source-assert-scan` 递归范围同步。
