# hehe-toolbox（核核工具箱）项目约定

> 工作区：`D:\zcode\hehe` · 版本：`0.9.7` · 更新：2026-11-26
> 本文件记录**项目重要事项与协作约定**（协作规则第 3 条）。
> 完整交接文档在 `D:\dsh\hehe-tool.md`（架构、逐域说明、踩坑大全、发版流程）。

## 一、协作约定（用户 2026-11-18 明确，2026-11-21 补充第 5、6 条）

1. **任何上传到网络的操作都要经过用户同意**
   - 包括 `git push`、推送 tag、发 Release、上传任何文件到网络。
   - “这次先同意”只对那一次有效；下一次仍需明确许可。
   - 本地 commit 不受限，但推送前必须取得许可。
2. **不要乱往工作区外放文件；临时文件记得删除**
   - 临时产物只放工作区内（`.tmp-*` 等临时目录，用完即删）。
   - 允许清理：`.tmp-*/`、`reports/`、`.shots/`、`*.log`（测试/调试产物，可重建）。
   - **不要删**：`dist/`（用户要求的产物固定位置）、`node_modules/`。
   - 例外：告警/审查文档等长期资料放工作区 `docs/`；用户指定的外部文档
     （如 `D:\dsh\hehe-tool.md`）按用户要求维护。
3. **工作区要有 `项目名称.md` 记录重要事项与约定** —— 即本文件。
4. **版本号规则**（见下节）。
5. **工具或功能坏了、解决不了要向用户报告** —— 不静默绕过，不把失败伪装成成功。
6. **不要默认用户什么都会** —— 专业术语首次出现要解释（例如：IPC = 进程间通信，
   portable = 免安装便携版，artifact = 构建产物）。
7. **先了解本机有哪些工具，选趁手的用**（2026-11-24 新增）
   - 动手前先盘点可用程序，不要拿着不顺手的工具硬做，也不要为了一个已装好的功能去装新的。
   - 本机清单见「七、本机可用工具」；环境变化后先复跑那份盘点命令再下结论。

## 二、版本号规则（2026-11-18 修订，覆盖旧规则）

格式 `x.y.z`，从 `0.0.1` 开始：

- **末位（z）只能是 0–9**，满 10 向中位进 1：`0.0.9 → 0.1.0`、`0.1.9 → 0.2.0`、
  `0.0.14 → 0.1.4`。
- **中位（y）可以 ≥10**，**不**向最大位进位：**`0.9.9 → 0.10.0`**（不是 1.0.0）、
  `0.10.9 → 0.11.0`、`0.99.9 → 0.100.0`。
- **最大位（x = major）只有得到用户明确允许才能升**：脚本必须同时给
  `--major` 与 `--approved`，否则拒绝（`node scripts/version.js --major --approved --write`）。
- 校验/预览/写入：
  ```bash
  node scripts/version.js              # 校验 package.json 当前版本
  node scripts/version.js --next       # 预览下一版（只动末位/中位）
  node scripts/version.js --next --write
  node scripts/version.js --major --approved --write   # 升最大位（需用户允许）
  ```
- 历史版本按旧规则发布（0.8.9 → 0.9.0），**新规则从 0.9.1 起生效**，不回改历史。

## 三、发版流程（与协作约定 1 配合）

1. 本地全绿：`npm test`（213 脚本 / 2403 断言基线；dist 与 package 同版本时会多跑 test-packaged-assets 的 27 条）+ `npm run lint` + `npm run typecheck`；
2. 升版本：`node scripts/version.js --next --write` + 同步 `package-lock.json`；
3. 写 `docs/release-notes/vX.Y.Z.md`（≥400 字）；
4. commit → **先问用户** → push → 等 CI 绿；
5. **再问用户** → `git tag -a vX.Y.Z` → push tag → Release workflow 自动构建发布；
6. 发布后：下载产物到 `dist/` 并核对 SHA256、跑 `verify-fixes-in-package.js`、
   更新 `D:\dsh\hehe-tool.md` 的 0/0.2/3.1/11/12 章与断言基线。

## 四、质量门禁（改代码前必读）

- 每次改动跑针对性测试；提交前 `npm test` 全绿、lint/typecheck 0。
- 断言基线：`scripts/assertions-baseline.json`，改测试后 `npm run test:count:write` 重拍；
  守卫只允许涨、不允许悄悄变少。
- 源码断言必须写「锁的是」（SA-4）：锁哪个历史回归 + 为什么不能行为化；
  能用行为断言就别用源码断言；读源码一律走 `readSrc/readTree/readMain`（SA-3）。
- 新 IPC 通道必须同步 `lib/channels.js` + `js/channels.js`（`MIGRATION.TOTAL` 对账），
  否则 `test-channels-sync` 红。
- 受保护操作（删文件、改注册表、电源、ACL、还原点删除等）必须走
  `CAP_GATED_CHANNELS` 门禁；破坏性分支必须 fail-closed，不能默认到更破坏的选项。
- 用户可见文案会原样渲染：不要用 Markdown 星号；图标用 `window.ui.icon()` 不用 emoji。

## 五、关键文件

| 文件 | 作用 |
|---|---|
| `main.js` / `ipc/*` | 主进程与 IPC 域 |
| `js/tools/*` | 111 个工具页 |
| `lib/*` | 纯逻辑（可单测，不 require electron） |
| `scripts/` | 测试 / 构建 / 发布脚本 |
| `docs/review-round*.md` | 历轮审查记录（含证据与排除的误报） |
| `docs/release-notes/` | 每版发布说明 |
| `dist/` | 产物固定位置（勿删；当前为 0.9.7 的 Portable exe + zip） |
| `D:\dsh\hehe-tool.md` | 完整交接文档（外部，用户指定维护） |

## 六、当前状态（2026-11-26 核对）

- 版本 `0.9.7`，tag `v0.9.7` → `979c03f`；`dist/` 为 0.9.7 的 Portable exe + zip。
- **开源为 MIT**：新增 `LICENSE`（2026 hehe）、README 许可段、
  `build.files` 纳入 LICENSE（原来产物里没有许可声明）。
- 上一版 Release（v0.9.6）：https://github.com/xiaohetaoo/hehe-toolbox/releases/tag/v0.9.6
  （zip 153.93 MB + Portable 99.17 MB，正文 3778 字，run 45562796271 success）
- **v0.9.6 内容**：R18~R21 四轮审查共 **62 项**修复 ——
  P0 6 项（批量停止按钮未接线、running 不复位、无 per-run 序号并发写盘、
  批量改名可重入、Unicode 解码坏的、电源门禁 5 类绕过）；
  P1 21 项（lib 顶层 const 冲突致 run-token 整份 SyntaxError、path-guard
  别人 home 深处、FFmpeg 直接写坏 exe、解锁进程名未归一、剪贴板图片交接丢失等）；
  P2/P3 35 项；UI 字号整数刻度 + 圆角 4/6/8/10 + 窄窗栅格。
- 质量门禁：`npm test` **218 脚本 / 2444 PASS / 0 失败 / 7 环境跳过**（371.1s），
  lint 0、typecheck 0；断言基线 **2444**（218 文件；R23 新增测试后）。
- `dist/` 已是 0.9.6 两个产物，产物校验 **7/7 通过**（M1~M7，含 LICENSE）。
- **测试环境注意**：`test-critical-dirs` 曾硬编码开发机用户名，CI（runneradmin）
  下被 OTHER_HOME 规则正确拦下而误报 —— 已改为动态 `os.homedir()` 并补成对断言。
- **下载通道**：官方 CDN 仍时好时坏（本次 zip 官方成功、exe 卡住后自动走镜像），
  `npm run dist:fetch <tag>` 已内置「官方优先 → 失败走镜像 + 官方 digest 双校验」。
- 待办：P3-7 批处理「续跑 vs 即停」策略待产品决定；
  `shutdown /a` 1116 路径、缩略图网格视觉密度、真实拖拽需实机确认。

## 十三、第 22 轮深度审查（2026-11-26，未提交）

- 范围：0.9.6 的纯逻辑边界、归档预检、磁盘健康、快捷启动旧数据与卡片视觉；明细见 `docs/review-round22.md`。
- 修复 6 项（按收益降序）：P2 长路径前缀 —— `lib/path-text.js` 与 `lib/env-path.js` 只认普通 `C:`，`\\?\C:\foo` 的 dirname 返回 `\\?\C:`、PATH 里退化成 `\\?\C:`，补扩展前缀盘符根；P2 归档 —— 先文件 `a` 后无尾斜杠目录 `a` 能通过预检、解压到一半才失败，补 `fileDirs` 对称检查；P3 快捷启动 —— 旧 store 的 null/缺 target 项会让整页渲染中断，跳过非对象并把字段兜成字符串；P3 磁盘健康 —— `hasAny` 漏 `startStop`，只有启停次数的盘自相矛盾地说「读不到 SMART」，补入判据；P3 视觉 —— 160px 卡片里的 40 字符无空格 URL 会横向溢出，`.tc-name/.tc-desc` 补 `max-width:100%` + `overflow-wrap:anywhere`。
- 新增测试：`test-round22-fixes.js`（2 条）、`test-path-text` +1、`test-env-path` +1、`test-archive-guard` +1、`test-disk-health` +1；`features.json` 登记 R22 测试。
- 门禁：`npm test` **217 脚本 / 2437 PASS / 0 失败 / 7 环境跳过**（367.7s，exit 0）；lint 0；typecheck 0；断言基线 **2437**（217 文件）；`HEHE_SMOKE=1` 111 页 PASS（cssRules=498）。
- 提交状态：所有改动仍在工作区，未提交、未 push；`docs/copyright/` 为用户原有未跟踪资料，未触碰。

## 十四、第 23 轮深度审查（2026-11-26，未提交）

- 范围：归档预检数据完整性、磁盘健康数值质量、PATH 盘符语义、UNC 共享根、快捷启动旧数据/默认名与空状态；明细见 `docs/review-round23.md`。
- 修复 6 项（按收益降序）：P2 归档 `size` 缺失/空串/NaN/Infinity 被 `|| 0` 绕过上限，改为文件条目必须有限非负、坏值 `BAD_SIZE`、目录可无 size；P2 磁盘健康空字段被 `Number('')=0` 伪装成读数、非有限数进入 verdict，统一 `numOrNull` 并让坏 `disks` 不抛；P2 PATH 把 `C:`/`C:\` 归一成同一项、根项会误删或误判已存在，且 `C:\Tools`/`C:\Tools\`/`C:/Tools` 会重复添加，分离盘符根并「先 strip 再语义去重」；P3 快捷启动 `/\.\\w+$/` 默认名正则失效、坏 store 的 null/缺 cmd 项会导致删除抛错或执行 `undefined`，改按最后一点切并过滤坏项；P3 `path-text` UNC 共享根 dirname 退化成主机名，新增共享根分支；P3 快捷项全是坏数据时只显示空网格，改为同一空状态提示。
- 新增测试：`test-round23-fixes.js`（2）、`test-archive-guard` +1、`test-disk-health` +2、`test-env-path` +1、`test-path-text` +1；`features.json` 登记 R23。
- 门禁：`npm test` **218 脚本 / 2444 PASS / 0 失败 / 7 环境跳过**（371.1s，exit 0）；lint 0；typecheck 0；断言基线 **2444**（218 文件）；`HEHE_SMOKE=1` 111 页 PASS（cssRules=498）。
- 提交状态：所有改动仍在工作区，未提交、未 push；`docs/copyright/` 为用户原有未跟踪资料，未触碰。

## 十五、第 24 轮深度审查与修复（2026-11-26，v0.9.7）

- 范围：6 路子代理分域只读审计（主进程/IPC、lib、渲染层、CSS/可访问性、工程脚本、媒体页补漏），主审交叉抽验；明细与逐项证据见 `docs/review-round24.md`。
- 审计结论：**P0 0、P1 1、P2 9、P3 41，共 51 条**；R18–R23 已修项不重复上报。
- 修复结果：**42 条全修、6 条部分修、3 条明确未修**。P1 电源门禁 `Start-Process`/`& $var` 绕过先修；P2 九项全落地：坏 store 四处归一、剪贴板双模态、dedupe 重入/进度串扰、dropzone 键盘、英文外壳、构建假成功、产物守卫假绿、office 离页复位、video-trim 离页暂停。
- P3 重点：IPC 入参校验（net/http/scan、mkdir、office outDir、seven、port、hwnd、save-image、hosts realpath）、lib 边界（target-size/dir-move/archive-guard/restore-point/errors/acl/lan/sensitive）、渲染层离页序号与 KILL、PDF 共享 busy、错误 toast 口径、modal/表格/toast/cmdk/表单/搜索可访问性、对比度 token、长 toast 换行、死 CSS、reduced-motion、辅助窗 `lang`/`alt`/splash 语言。
- 新增测试：`test-round24-fixes.js` **49 条**、`test-powergate` +6（83→89）；`features.json` 新增 `round24` 域并登记测试。基线 2444（218 文件）→ **2499（219 文件）**，只按实际新增上调。
- 门禁：`npm run lint` 0；`npm run typecheck` 0；`npm test` **219 脚本 / 2499 PASS / 0 失败 / 7 环境跳过**（341.8s，exit 0）；`npm run test:count` 2499 PASS；`HEHE_SMOKE=1` **pages=111 cssRules=493 PASS**，`snip/pin/ruler` 均 `scripts=3, csp=on`。
- 视觉/可访问性：未做逐页人工点击与读屏走查；用 CSS/源码契约 + 111 页 smoke 覆盖。`cssRules` 498→493 来自死规则清理，非解析中断。
- 未修/风险：R24-45 release/updater 链路分叉、R24-46 asar 瘦身、R24-51 `jsconfig` 覆盖 3 项未修；R24-29/43/47/48/49/50 部分修；R24-18/19 未做真实 hosts 写入与长任务退出实测，只做代码级证实并记录，未夸大为已复现。
- 测试环境限制：本机 Chromium 单实例锁文件创建失败（error 5），冒烟时临时绕过 `requestSingleInstanceLock`，跑完已恢复，`main.js` SHA256 与改前一致；仓库未保留临时改动。
- 提交状态：本轮未 commit、未 push；`docs/copyright/` 未触碰；未跑 dist、未构建发布产物。

## 十六、第 25 轮深度审查与修复（2026-11-26，未提交）

- 范围：在 R24 未提交改动上继续做全仓静态审查，重点补路径闸门、任务生命周期、解压/下载边界、网络探测内存上限与窄窗布局；明细见 `docs/review-round25.md`。
- 主要修复：盘符相对路径（`C:foo`）在删除/覆盖/改权限/改名四处一致拒绝；`walkDir`/空目录扫描/垃圾扫描/清理全部跳过 junction，清理链接只删链接本身；`scan-empty-dirs` 不再把用户选中的扫描根列进待删清单；媒体批处理先校验输出目录再登记 job，避免幽灵任务；`FFMPEG.DOWNLOAD` 先建 bin 目录再登记 job；更新包 PE 校验与 SHA-256 改用同一文件句柄；`notes:pdf` 直传已存在路径拒绝覆盖；静态服务修正 `D:\` 根前缀；`NET.HTTP` 加 64MB 流式上限；测速采满时间窗后取消响应流；`archive-process` 最终复查不容忍根目录缺失；`SCHED.ONCE_ADD` 拒绝未知动作；启动临时清扫跳过链接；`package.json` asar 排除 `.ts/.d.ts/README/CHANGELOG`。
- 新增测试：`scripts/test-round25-fixes.js` **26 条**（全部 PASS）；`test-crypt-guard` 改为按完整 `cryptStream` 函数体取片段，6 条 PASS。
- 门禁：`npm run lint` 0；`npm run typecheck` 0；`npm run test:unit` **188 脚本 / 2109 PASS / 0 失败 / 3 环境跳过**（114.3s）；`test-source-assertions` 6 条 PASS。
- 未修/风险：R24-45 release/updater 分叉、R24-51 jsconfig 覆盖、R24-43 辅助窗逐字符串翻译仍留待后续；`test-i18n-assertions` 未递归；`HOSTS.BACKUP` 未并入 hosts 串行锁；UI 固定宽度候选已逐项核对，仍建议真实窗口截图复核。
- 提交状态：本轮未 commit、未 push；`docs/copyright/` 未触碰；未跑 dist、未构建发布产物。

## 十七、第 26 轮连续深查与修复（2026-11-27 凌晨，未提交）

- 范围：承接 R25 工作区，继续静态审查搜索、Office 转换、媒体任务、hosts、辅助窗语言、局域网扫描与 i18n 守卫；明细见 `docs/review-round26.md`。
- 主要修复：Office COM 在 `ps` 超时/抛异常时也清半截目标；四条搜索入口的 limit 统一为有限正数、空内容查询直接拒绝、`drive` 大小写归一；内容搜索 `walkDir` 失败也发 `done` 并在 `finally` 清任务；视频裁剪在探测前/探测失败/spawn 前补取消检查；LAN 扫描旧一趟不再拆新一趟订阅或藏进度条；`HOSTS.BACKUP` 并入 hosts 串行锁；辅助窗 `loadFile` 带 `lang` 且首次打开按语言渲染提示/按钮；实时坐标页离开时复位开关；i18n 源码断言守卫递归子目录。
- 新增测试：`scripts/test-round26-fixes.js` **10 条**（全部 PASS）；`scripts/source-assertions-baseline.txt` 收紧 `test-single-instance` 的 B 计数 13→12。
- 门禁：`npm run lint` 0；`npm run typecheck` 0；`scripts/test-round26-fixes.js` 10 条 PASS；`scripts/test-source-assertions.js` 6 条 PASS（源码断言 1724、1260 条已写「锁的是」）；`test-i18n-assertions` 224 条全过；`test:unit` 189 脚本 / 2119 PASS；完整 `test:count:write` 222 脚本 / 2537 PASS，基线已重拍，`--no-run` 核对无文件低于基线。
- 未修/风险：R24-45 release/updater 分叉、R24-51 jsconfig 覆盖仍留待后续；辅助窗已打开后再切语言的问题已在 R27 补齐（见下）；`HOSTS.BACKUP` 未做真实 hosts 写入实测；UI 固定宽度仍建议真实窗口截图复核。
- 提交状态：本轮未 commit、未 push；`docs/copyright/` 未触碰；未跑 dist、未构建发布产物。

## 十八、第 27 轮连续深查续（2026-11-27 凌晨，未提交）

- 范围：补齐 R26 遗留的「辅助窗已打开后切语言不更新」；继续复核网络测速上限与局域网扫描进度隔离。明细见 `docs/review-round27.md`。
- 主要修复：`pin-1/ruler-1/snip-1` 收到 `UI_PREFS_CHANGED` 后只在语言真变时派发 `hehe-lang`；`pin` 提示文字、`ruler` 四个 title、`snip` 工具条/调色板/线宽提示即时重画；`snip` 的 `EN` 改为可变，重建工具条时保留 `tool/color/size`；截图工具 `TOOLS` 改为四元组按当前语言取 label；`NET.SPEEDTEST` 上行响应改用 `readHttpCapped` 截断并检查 `r.ok`；分片/合并/7z/ZIP 长操作按钮统一 `ui.guard` 防双击并发；`LAN.SCAN` 进度带本轮 token，旧一趟不能覆盖新一趟。
- 新增测试：`scripts/test-round27-fixes.js` **7 条**（全部 PASS）；`scripts/test-aux-lang-live.js` 真实加载 pin/ruler/snip，验证 en→zh→en 往返。
- 门禁：`npm run lint` 0；`npm run typecheck` 0；`test-snip-e2e` 9 条、`test-snip-toolbar-ui` 13 条、`test-aux-windows-csp` 18 条、`test-net-tools` 1 条全过；完整 `test:count:write` **224 脚本 / 2545 PASS**，基线已重拍，`--no-run` 核对无文件低于基线；`test-source-assertions` 6 条（源码断言 1751、1287 条已写「锁的是」）、`test-i18n-assertions` 226 条全过。
- 提交状态：本轮未 commit、未 push；`docs/copyright/` 未触碰；未跑 dist、未构建发布产物。

## 十九、第 28 轮五小时深查（2026-11-27 夜间，未提交）

- 范围：只查代码，不手工实机；重点复核页面保活后的长任务状态、异步换文件竞态、窄窗布局。明细见 `docs/review-round28.md`。
- 主要修复：磁盘分析页 cleanup/onEnter/finally 与进度序号复位，空目录扫描防双击；PDF 页面管理 `loadSeq` 防止旧读取覆盖新文档；压缩包预览 `pvSeq` 丢弃旧 LIST；文档预览捕获 `target` + `previewSeq` 停笔；PDF 水印/提取/瘦身捕获 `srcPath`；屏幕坐标 4 格、实时速率 5 格改 `auto-fit` 窄窗落列。
- 新增测试：`scripts/test-round28-fixes.js` **10 条**（全部 PASS）。
- 门禁：`npm run lint` 0；`npm run typecheck` 0；完整 `test:count:write` **225 脚本 / 2555 PASS**，基线重拍；`test-source-assertions` 6 条（源码断言 1784、1320 条已写「锁的是」）；`test-i18n-assertions` 227 条；`test-round28-fixes`、`test-pdf-pages`、`test-round16-behavior`、`test-round25-fixes` 全过。
- 提交状态：未 commit、未 push；`docs/copyright/` 与 `dist/` 未触碰；7 个环境脚本按既有原因跳过。

## 二十、第 29 轮继续深查（2026-11-28 凌晨，未提交）

- 范围：承接第 28 轮继续查页面保活生命周期，重点看 `onCleanup` 后没有 `onEnter` 复位的页面。明细见 `docs/review-round29.md`。
- 主要修复：网速测试页的 `disposed` 在切页后永久为 true，复用回来按钮静默失效；新增 `speedRunSeq` 每轮序号与 `onEnter` 复位，旧 await 结果、旧 `job:stream`、旧 `finally` 都不再碰当前轮。工具链 `runChain` 增加 `shouldStop`，离开页面后不再启动下一步（当前步无法中断）。
- 新增测试：`scripts/test-round29-fixes.js` **7 条**（全部 PASS）。
- 门禁：`npm run lint` 0；`npm run typecheck` 0；完整 `test:count:write` **226 脚本 / 2562 PASS**，基线重拍；`test-source-assertions` 6 条（源码断言 1795、1331 条已写「锁的是」）；`test-i18n-assertions` 228 条。
- 提交状态：未 commit、未 push；`docs/copyright/` 与 `dist/` 未触碰；7 个环境脚本按既有原因跳过。
