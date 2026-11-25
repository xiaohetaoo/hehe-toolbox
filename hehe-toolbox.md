# hehe-toolbox（核核工具箱）项目约定

> 工作区：`D:\zcode\hehe` · 版本：`0.9.5` · 更新：2026-11-22
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
| `dist/` | 产物固定位置（勿删；当前为 0.9.3 的 Portable exe + zip，0.9.4 待下载） |
| `D:\dsh\hehe-tool.md` | 完整交接文档（外部，用户指定维护） |

## 六、当前状态（2026-11-24 核对）

- 版本 `0.9.5`，tag `v0.9.5` → `a14714b`；HEAD 与 origin/main 同步。
- Release：https://github.com/xiaohetaoo/hehe-toolbox/releases/tag/v0.9.5
  （zip 153.91 MB + Portable 99.16 MB，正文 3382 字，run 45338457173 success）
- **v0.9.5 内容**：修 v0.9.4 的退出码检查死代码（EXEC.RUN 未透传 allowNonZero，
  数字退出码回不到渲染层）；连带补齐 14 处同类死代码；定时取消按类型分流
  （1116 = 没有计划也算成功、提醒零 IPC、只撤本页 onceId）；批量任务生命周期收口
  （TTS / 命令收藏 / 目标压缩 / 四个批量页 + 混淆页停止按钮 / 全仓 per-run token）；
  img-dedup 改缩略图网格。
- 质量门禁：`npm test` **216 脚本 / 2430 PASS / 0 失败 / 7 环境跳过**（349.7s，exit 0），
  lint 0、typecheck 0；断言基线 **2430**（216 文件）。
- **R17 后续修复已入库**：per-run token 补齐（audio-cut / video-frames / office /
  chain / sys-tools 磁盘分析 / img-scramble / pdf-plus 三卡 / pdf-pages）随
  `d3827ef` 提交并已与 `origin/main` 同步；工作区当前干净。
  该提交说明写的是「dist 补齐 + fetch-dist 镜像回退」，与代码改动内容不符 ——
  历史已推送，不再改写，仅在此登记事实。
- `dist/` 已是 0.9.5 两个产物，产物校验 **15/15 通过**（L1~L15）。
- **下载通道注意**：官方 `release-assets.githubusercontent.com` 在本机被阻断
  （Node fetch / Invoke-WebRequest / curl 三种方式均 0 字节，而 Cloudflare 对照正常）。
  `scripts/fetch-dist.js` 已内置镜像回退（ghfast.top）并按官方 API 的 digest
  做 SHA-256 双校验，直接用 `npm run dist:fetch <tag>` 即可。
- 待办：P3-7 批处理「续跑 vs 即停」策略待产品决定；
  `shutdown /a` 返回 1116 的路径、缩略图网格视觉密度需实机确认。

## 七、本机可用工具（2026-11-24 盘点）

> 盘点命令：`foreach ($n in 'git','node','npm','python','ffmpeg','ffprobe','7z','pwsh','rg','code') { Get-Command $n -ErrorAction SilentlyContinue }`

| 工具 | 位置 / 版本 | 本项目里的用途 |
|---|---|---|
| git | `C:\Program Files\Git\cmd\git.exe` | 提交、看 diff、比对 HEAD |
| node / npm | 随沙箱运行时提供 | 跑单测、lint、typecheck、版本脚本 |
| python | 随沙箱运行时提供 | 临时计算、脚本验证 |
| ffmpeg / ffprobe | winget 安装的 Gyan 9.0.2 full build | 媒体功能实机验证（本应用也依赖它探测硬件编码） |
| 7z | `C:\Program Files\7-Zip\7z.exe` | 压缩包相关验证 |
| pwsh | 随沙箱运行时提供 | 本机 shell 主力（Bash 在此主机不可用） |
| rg | 随沙箱运行时提供 | 快速全文检索 |
| code (VS Code) | 未安装 | —— |

注意：应用自带的 ffmpeg 探测走它自己的路径解析，与上表这份系统级 ffmpeg 是两套，不要混用结论。

## 八、协作习惯备忘（2026-11-24）

- 每轮结束：清理 `%TEMP%` 下本项目产生的 `hehe-*` 临时产物（日志、探测目录、录制分段），
  工作区只留 `docs/` 里的长期资料。
- 报告结论时先给事实（跑过什么、结果多少），再说判断；不把「没验证」写成「已确认」。
- 代码改动落到 HEAD 之后要如实说明提交状态，不要沿用「未提交」这类过期描述。

## 九、第 18 轮深度审查（2026-11-24 夜，未提交）

- 范围：48 个工具页 + `js/` 根模块 + `css/app.css` + 相关 `ipc/`、`lib/` 路径；明细见 `docs/review-round18.md`。
- 修复 26 项（按收益降序）：6 项 P0（批量页「停止」按钮从未启用 / 离开页面 `running` 不复位 / 批量任务缺 per-run 序号导致双写 / 批量改名与改后缀可重入 / `text-codec` Unicode 解码正则多一层反斜杠，emoji 永不合并）；9 项 P1；8 项 P2；3 项 P3。
- UI：清掉全部半像素字号（13.5/12.5/11.5px），圆角收口到 4/6/8/10 刻度，新增 860px / 820px 两个窄窗断点（三栏改上下堆叠、卡片内边距收紧），删死样式 `.tool-grid.cols-4`，命令面板文案双语。
- 测试：新增 `test-text-codec-unicode.js`（7 条）、`test-round18-fixes.js`（18 条）；修正 `test-snip-toolbar-ui.js` 线宽测量（DPR≠1 时竖向量法恒失败）、`test-restore-point.js` RP6 扫描窗口；基线 `test-lan-scan.js` 的 B 由 1 收紧为 0。
- 门禁：`npm test` **211 脚本 / 2374 PASS / 0 失败 / 7 环境跳过**（350.2s，exit 0）；lint 0；typecheck 0；断言基线重拍 `total=2374`（211 文件）。
- 提交状态：全部改动留在工作区，未提交、未 push（用户未授权）。`d3827ef` 说明与内容不符一事仍只登记、不改写历史。
- 未做实机点击验证：行为结论来自源码逐行阅读 + 仓库测试（部分 E2E 自启 Electron）。手势/拖拽/真实 ffmpeg 输出建议实机复核。

## 十、第 19 轮深度审查（2026-11-24 深夜，未提交）

- 范围：`ipc/fs-ops.js`、`ipc/media-ffmpeg.js`、`ipc/dir-acl-links.js`、`ipc/env-manager.js`、`ipc/net-lan.js`、`ipc/ctx.js`、`lib/*`、`main.js` 高风险路径、`index.html` 脚本加载顺序；明细见 `docs/review-round19.md`。
- 修复 18 项（按收益降序）：1 项 P0（电源门禁只看可执行位首词，`schtasks /tr "shutdown /s"`、`at`、`Invoke-CimMethod`、`Win32Shutdown` 全部绕过）；12 项 P1（`run-token`/`img-pick` 顶层 `const API/root` 撞名导致 RunToken 整份脚本 SyntaxError；别人 home 深处可删/可覆盖；相对根扫描体积归零；空目录/查重返回相对路径删不掉；分片用 `bytesWritten` 判换片会超片；REC.STOP 早退不复位；FFmpeg 三处直接写 bin exe；目录搬家超限链接静默丢失；测速可永久挂起；解锁进程名未归一；剪贴板图片 `dataUrl` 交接丢失；冒烟 px 全等在 125% 缩放下误报）；3 项 P2（`pi%`/`e%` 报「表达式不完整」、剪贴板两处弹窗 `modalEl` 不复位、图片动作推荐无法导入图片的「截图标注」）；2 项 P3（测速参数类型注解、`.hs-kbd` 圆角 5→4）。
- 新增测试：`test-lib-globals.js`（共享 vm 上下文按 index.html 顺序真实加载 + 静态扫描全部脚本顶层词法名）、`test-round19-fixes.js`（S1–S13 源码契约）、`scripts/lib/fs-handlers.js`（真实 register 装 handler 供行为测试调用）；`test-split-stream`、`test-scan-tree`、`test-powergate`、`test-path-guard`、`test-file-unlock-release`、`test-expr-eval` 补行为用例；`features.json` 与 `test-temp-names` 的 rename 清单同步。
- 门禁：`npm test` **213 脚本 / 2403 PASS / 0 失败 / 7 环境跳过**（352.0s，exit 0）；lint 0；typecheck 0；断言基线重拍 **2403**（213 文件）。
- 实机检查：隔离 userData 下 `HEHE_SMOKE=1` 遍历 111 个工具页 PASS（cssRules=498），snip/pin/ruler 辅助窗 CSP 正常；截图目检首页/设置/图片压缩/压缩解压/文本统计 5 页，启动控制台异常已清零。
- 提交状态：全部改动留在工作区，未提交、未 push（用户未授权）。`d3827ef` 说明与内容不符一事仍只登记、不改写历史。

## 十一、第 20 轮深度审查（2026-11-25 凌晨，未提交）

- 范围：`main.js` 的 `SCHED/ONCE`、`TTS.SPEAK/WAV`、`SEVEN.COMPRESS`、`createPinWindow`；`js/tools/text-tools.js` 本地笔记；`js/clip-actions.js` 路径动作；`lib/once-schedule.js`、`lib/safe-name.js`；明细见 `docs/review-round20.md`。
- 修复 11 项（按收益降序）：3 项 P1 —— 笔记切换/新建无提示覆盖未保存的正文/标题/标签（新增 `confirmDiscard` + 已保存快照）、损坏的 `fireAt` 让 `setTimeout(NaN)` 退化为 1ms 导致**启动即睡眠/锁屏**（抽 `lib/once-schedule.js` 统一 drop）、未知 `action` 落到 `else` 仍会睡眠（改为只显式处理 `lock/sleep`）；7 项 P2 —— `TTS.WAV` 直接截断目标改为临时文件 + `writeFileAtomic`、TTS 数值参数 `[int]NaN`、TTS 导出忽略界面音量且无长度上限、7z `-vNaNm`、贴图临时 PNG 关闭即删、笔记删除失败被 `.catch` 吞掉、损坏的周期任务 store 拖垮启动；1 项 P3 —— 剪贴板 `C:\foo` 的“所在目录”算成 `C:`、目录尾斜杠复制文件名为空、超长文件名硬截断停在空格。
- 新增测试：`test-once-schedule.js`（7 条行为）、`test-round20-fixes.js`（S1–S10 + S6b 源码契约）；`test-safename` 补 1 条截断尾空格；`features.json` 同步。
- 门禁：`npm test` **216 脚本 / 2430 PASS / 0 失败 / 7 环境跳过**（349.7s，exit 0）；lint 0；typecheck 0；断言基线重拍 **2430**（216 文件）。
- 实机检查：隔离 userData 下 `HEHE_SMOKE=1` 遍历 111 个工具页 PASS（cssRules=498），snip/pin/ruler 辅助窗 CSP 正常。
- 提交状态：全部改动仍在工作区，未提交、未 push。遗留：新笔记从未保存时切工具页仍可能丢草稿（需草稿落盘产品取舍）；`SNIP action='ocr'` 临时图仍靠启动清扫。

## 十二、第 21 轮深度审查（2026-11-25 凌晨，未提交）

- 范围：渲染层输出目录推导（`js/tools/*` 与 `media/*`）、`js/ui.js` 文件列表、`main.js` 的 TTS 长度上限与自启备份、`lib/path-text.js`、`lib/env-path.js`、`js/tools/launch.js`、`js/tools/security.js`；明细见 `docs/review-round21.md`。
- 修复 7 项（含 1 项测试稳定性）：P2 路径收口 —— 10 个页面各写一份 `replace(/[\\/][^\\/]*$/, '')`，`C:\foo` 得到盘符相对路径 `C:`，顶层文件/盘符根/默认输出目录/“上一级”都会算错，新增 UMD `lib/path-text.js` 统一从 `window.PathText` 取；P2 TTS —— 渲染层虽拦 5000 字，IPC 本身没有上限，超长文本一次 Speak 会把主进程锁到念完，`SPEAK`/`WAV` 入口都补长度校验；P3 自启备份 —— store 损坏成非数组时 disable 的 `.find` / enable 的 `.filter` 抛错（enable 抛在 `reg add` 已成功之后，界面误报“失败”），三处补数组兜底；P3 PATH —— `prependEntries` 去尾分隔符把 `C:\` 写成 `C:`（盘符相对路径），新增 `stripTrailingSep` 保留盘符根；P3 快捷启动/命令收藏 —— store 坏成非数组时 load/add/delete 抛，五处补数组兜底；P3 剪贴板历史 —— `clipHistory` 坏成非数组时 `sweepSensitive`/`unshift` 抛，load 补数组兜底；P3 测试 —— `test-dir-move-impl` 的 `repeat(70)` 在 tmpdir 偏短的机器上总长 32539，低于 32767 上限，改为 `repeat(100)` 稳定触发分批。
- 新增测试：`test-path-text.js`（4 条行为）、`test-env-path` EP6；`test-round20-fixes` 增 S11–S13 与 TTS IPC 长度断言；`features.json` 登记 `lib/path-text.js`。
- 门禁：`npm test` **216 脚本 / 2430 PASS / 0 失败 / 7 环境跳过**；lint 0；typecheck 0；断言基线重拍 **2430**（216 文件）；`HEHE_SMOKE=1` 111 页 PASS（cssRules=498）。
- 提交状态：全部改动仍在工作区，未提交、未 push。遗留：`PathText` 未处理 `\\?\C:\` 扩展长度前缀；`AUTOSTART` 仍信任渲染层 `item`，与 R20 判断一致。
