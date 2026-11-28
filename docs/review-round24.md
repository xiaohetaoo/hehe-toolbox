# hehe-toolbox 第 24 轮审查与修复记录（R24）

- 审计对象：`D:\zcode\hehe`，审查时版本 0.9.6，HEAD `18bb3c7`（含 R22/R23 未提交改动）；修复落地时版本 0.9.7。
- 审计方式：6 路子代理分域只读审计（主进程/IPC、lib 纯逻辑、渲染层、CSS/可访问性、工程脚本、媒体工具页补漏）+ 主审交叉抽验；未修改仓库、未启动 GUI、未跑全量测试。
- 审计结论：**P0 0 条，P1 1 条，P2 9 条，P3 41 条，共 51 条**。R18–R23 已修项未重复上报。
- 修复原则：按收益降序；只改已确认问题；P1 先修；不做无关重构、不改 UI 风格、不跑 dist、不构建发布产物、不提交/push、不碰 `docs/copyright/`；不执行真实关机/重启。
- 写入约束：子代理只做只读分析/独立验证；源码与测试文件由主审串行写入，同一文件只有一个写入者。

---

## 一、结论摘要

| 严重度 | 审计 | 已修 | 部分修 | 未修 |
|---|---:|---:|---:|---:|
| P1 | 1 | 1 | 0 | 0 |
| P2 | 9 | 9 | 0 | 0 |
| P3 | 41 | 32 | 6 | 3 |
| **合计** | **51** | **42** | **6** | **3** |

- 部分修：R24-29（只修测速页与 ffmpeg-setup，file-tools 一次性订阅仅保留 finally 退订）、R24-43（辅助窗只补 `lang`/`alt`/语言广播，未逐字符串翻译）、R24-47（增量选择已修，未登记模块清单未补齐）、R24-48（CI 递归与 exit-only 记账已修，源码断言递归扫描未改）、R24-49（脚本三项已修，release digest 校验未补）、R24-50（5 个 html 与 release 接线已修，round3 改读 asar 未做）。
- 未修：R24-45（release/updater 链路分叉）、R24-46（asar 瘦身，需构建产物验证）、R24-51（`jsconfig.json` 类型检查覆盖面）。
- 未复现/仅静态证实：R24-18（未向真实 hosts 写入，代码级探针证实 `copyFile` 跟随 reparse、修复后 `lstat` 拒绝）、R24-19（未跑长任务退出实测，静态缺口明确并按退出路径加固）。没有把未复现项当作“已证实 bug”夸大。

---

## 二、P1 修复明细

| 编号 | 结论 | 改动文件 | 修复内容 | 测试证据 |
|---|---|---|---|---|
| R24-01 | 已修 | `lib/power-gate.js`、`scripts/test-powergate.js`、`scripts/test-round24-fixes.js` | 新增 `tokenizeArgs` 与 `launcherInner(seg)` 递归：解析 `Start-Process` 的 `-FilePath`/`-ArgumentList`，powerShell 外壳缺 `-c` 时补 `-c`；`start-process + -argumentlist + 危险词` 兜底；`& $var` 裸变量 fail-closed（含 `splitSegments` 吃掉 `&` 后只剩 `$c`、原文有调用运算符的情况） | `node scripts/test-powergate.js` 89/0（原 83，+6）；`test-powergate-ps` 7/0；`test-round24-fixes` 3 条判定（`Start-Process powershell -ArgumentList`、`$c=...; & $c` 拦，`echo hello world` 放） |

安全说明：危险命令探针一律用 `Write-Output`/字符串等价替换，未执行关机、重启、休眠。

---

## 三、P2 修复明细（按收益降序）

| 编号 | 结论 | 改动文件 | 修复内容 | 测试证据 |
|---|---|---|---|---|
| R24-02 | 已修 | `js/app.js`、`js/tools/life.js`、`js/tools/security.js`、`main.js` | `favorites/recents` 读取 `Array.isArray` + 字符串过滤，`toggleFavorite/pushRecent` 兜底；`life` 加 `asNotes` 归一 + `writeChain` 串行化；`security` 条目级过滤（text 要 string content、image 要 string file），`kindOf` 对 null/非对象兜底；`ONCE_LIST/ADD/REMOVE` 数组归一 + 条目对象过滤 | `test-round24-fixes` 行为断言；全量 `npm test` 含既有 store/坏数据用例 |
| R24-03 | 已修 | `js/clip-actions.js` | 新增 `opening`；`show()` 在 `await readClipboard()` 期间第二次调用直接 return，`finally` 复位 | `test-round24-fixes` 源码契约 + 既有剪贴板测试 |
| R24-04 | 已修 | `js/tools/file-tools.js` | dedupe 新增 `dedupeBusy`/`dedupeSeq`，按钮禁用，`job:progress` 按轮次过滤，旧轮结果不写 | `test-round24-fixes` 源码契约；features 工具测试 |
| R24-05 | 已修 | `js/ui.js` | dropzone 补 `tabIndex=0`、`role=button`、`aria-label`、Enter/Space keydown | `test-round24-fixes` 源码契约；smoke 全页加载 |
| R24-06 | 已修 | `js/i18n.js`、`js/ui.js`、`js/app.js` | zh/en 各补约 30 键（dialog/picker/dropzone/expand/list/duration/pane/app）；`ui.js` 新增 `TV(key,vars,fallback)`，替换 alertBox、文件选择、dropzone、列表头、时长等硬编码；`app.js` 替换主题/热键/运行中/窗口/坏 store/高危标签 | `test-i18n-coverage` 17/0；`test-tool-i18n-e2e` 4/0；`test-round24-fixes` |
| R24-07 | 已修 | `scripts/build-portable.sh` | `pack_zip` 失败即 `exit 1`，打印日志尾部，不再假成功 | 源码契约 `test-round24-fixes`；脚本语法自检 |
| R24-08 | 已修 | `scripts/verify-fixes-in-package.js`、`.github/workflows/release.yml` | 产物读不到被检文件由 SKIP 改 FAIL 并计入退出码；release 在 round4 校验后执行 `node scripts/verify-fixes-in-package.js` | `test-round24-fixes` 源码契约；workflow YAML 结构断言 |
| R24-09 | 已修 | `js/tools/office.js` | `onEnter` + `run` 的 running 提示；cleanup 后 finally 换“上一批转换已完成，可再次开始”；startBtn 可再次点击但 running 闸保留 | `test-round24-fixes`（`running`/按钮复位契约）；smoke |
| R24-10 | 已修 | `js/tools/media/video-trim.js` | `pageCleanup` 加 `video.pause()` | `test-round24-fixes` 断言 cleanup 含 `pause()` |

---

## 四、P3 修复明细

### A. 安全与健壮性（18 条）

| 编号 | 结论 | 改动文件 | 修复内容 | 测试证据 |
|---|---|---|---|---|
| R24-11 | 已修 | `ipc/net-lan.js` | `isHttpUrl`；`net:http` 只允许 http/https、方法 GET/HEAD/POST/PUT/DELETE/PATCH、timeout 1000-120000；speedtest 自定义 url 同校验 | `test-round24-fixes`；`test-ipc-channels` 9/0 |
| R24-12 | 已修 | `ipc/media-ffmpeg.js` | `gain` 改 `Number` 有限性检查 + `-96..60` dB 夹取，滤镜串只拼有限数值 | `test-round24-fixes` 源码契约；既有 ffmpeg 参数测试 |
| R24-13 | 已修 | `ipc/fs-ops.js`、`main.js` | `fs:mkdir` 校验非空字符串 + `isProtectedForModify`/`isCriticalPath` 拒绝；`office:convert` outDir 同口径并校验 files 数组 | `test-destructive`；`test-round24-fixes` |
| R24-14 | 已修 | `main.js` | `seven:compress` 校验 files 字符串数组、out 非空 + `checkOverwritable` | `test-round24-fixes` 源码契约；`test-destructive` |
| R24-15 | 已修（部分诉求） | `main.js` | `server:start` 端口 `Number` 夹 1-65535，否则 8128；未加一次性 token（已记录风险） | `test-round24-fixes` 源码契约；server 既有测试 |
| R24-16 | 已修 | `main.js` | winmgr 四通道加 `hwndNum` 校验 | `test-round24-fixes` 源码契约 |
| R24-17 | 已修 | `main.js` | `clip:save-image` 校验 `data:image` png/jpeg/webp/gif + base64 + 32MB 上限 | `test-round24-fixes` 源码契约 |
| R24-18 | 已修（代码级证实，未写真实 hosts） | `main.js` | `hosts:restore` 对 abs 取 realpath 后确认仍在备份目录内，`lstat` 只接受普通文件，拒绝 reparse point | 源码契约 + 最小探针确认 `copyFile` 默认跟随 reparse；未对真实 hosts 做写入复现（避免系统副作用） |
| R24-19 | 已修（静态证实） | `main.js` | `will-quit` 遍历 `jobs.cancel`/`jobs.delete`；主窗 `closed` 调 `jobs.cancelOwnedBy(win.webContents.id)` | `test-round24-fixes` 源码契约；未跑长任务真实退出实测，运行期残留未复现 |
| R24-20 | 已修 | `ipc/net-lan.js` | `net:scan` 校验 host/ports 数字数组（1-65535）、并发 1-1000、超时 50-5000 | `test-round24-fixes`；`test-ipc-channels` |
| R24-21 | 已修 | `lib/target-size.js` | 入口 `Number.isFinite(tb) && tb > 0`，`totalKbps` 改用 `tb` | `test-round24-fixes`：`Infinity` → `ok:false`、`videoKbps:null` |
| R24-22 | 已修 | `lib/dir-move.js` | 坏 `needBytes` 返回 `NEED_SIZE_INVALID`；null/undefined 保留 0 + `needBytesUnknown:true`；正常返回同字段 | `test-round24-fixes`：`-1`/`'abc'` 拒绝、未知放行并标记 |
| R24-23 | 已修 | `lib/archive-guard.js` | 非法字符正则并入 `\x00-\x1f` | `test-round24-fixes`：`foo\u0001bar` → `ILLEGAL_CHAR` |
| R24-24 | 已修 | `lib/restore-point.js` | `parseSizeToken` 加 `n < 0` 返回 `null` | `test-round24-fixes`：`-1 GB` → null，`1.5 GB` 正常 |
| R24-25 | 已修 | `lib/errors.js` | 新增 `ERRNO_MAP`（1/2/5/13/16/28/32/110/4058/112），无字符串 code 时按 `Math.abs(errno)` 映射 | `test-round24-fixes`：`errno 28` → `DISK_FULL`，`-4058` → `NOT_FOUND` |
| R24-26 | 已修 | `lib/acl-repair.js` | `isPlausiblePrincipal` 排除 `/^S-1-/i` 裸 SID | `test-round24-fixes`：`S-1-5-32-545` → false |
| R24-27 | 已修 | `lib/lan-scan.js` | `parseArp` 匹配后校验四个八位组 0-255 且字符串规范 | `test-round24-fixes`：`256.1.2.3` 丢弃、合法地址保留 |
| R24-28 | 已修 | `lib/sensitive.js` | 新增 `looksLikeBase64Secret`：base64 规则命中后要求含 `+/=` 或大小写+数字混合，纯字母长串跳过 | `test-round24-fixes`：40 个 `a` → 非敏感；混合字符 → 敏感 |

### B. 渲染层生命周期与错误反馈（9 条）

| 编号 | 结论 | 改动文件 | 修复内容 | 测试证据 |
|---|---|---|---|---|
| R24-29 | 部分修 | `js/tools/net-tools.js`、`js/tools/media/ffmpeg-setup.js`、`js/tools/file-tools.js` | 测速页新增 `speedJobId`/`disposed`、`App.onCleanup` 退订 + `JOB.KILL`，写 DOM 前判 disposed；ffmpeg-setup 加 `disposed`，cleanup 置位，finally 仅在未离页时复位/refresh；file-tools 四个一次性 `job:progress` 只保留 finally 退订，未加 `isConnected` 检查 | `test-round24-fixes`（`JOB.KILL`/`disposed`/`video.pause` 契约）；smoke |
| R24-30 | 已修 | `js/ui.js`、`js/tools/office.js` | `guard(fn, opts)` 支持 `opts.state` 共享 busy；`pdfGuardState={busy:false}`，四个 PDF 操作共用 | `test-round24-fixes`：`pdfGuardState` 与 `state.busy` 契约 |
| R24-31 | 已修 | `js/tools/env-manager.js` | install/remove/apply/unapply 确认框返回后 `if (busy) return toast(...)` | `test-round24-fixes`：`if (busy) return` 契约 |
| R24-32 | 已修 | `js/tools/hash.js`、`media/batch-ocr.js`、`img-compress.js`、`av-convert.js`、`video-press.js` | 文本哈希 catch 改 toast；TXT 导出包 try/catch；MKDIR 失败 toast + 复位 running/按钮并 return；批量部分成功 toast 改 `okN===total?'success':(okN?'warn':'error')` | `test-round24-fixes`：错误口径/“输出目录不可写”/三元 warn 契约 |
| R24-33 | 已修 | `js/app.js` | `drawAppearance(body, token)`，主题卡 await 后判 token，STORE.GET 回调判 token；data.clear 两次 SET 包 try/catch，失败 toast 且不先复位 state | `test-round24-fixes`：`drawAppearance` + `token !== drawToken` 契约 |
| R24-34 | 已修 | `js/tools/life.js` | `writeChain` 串行化 mutate，替换 add/toggle/delete 的读改写 | `test-round24-fixes`：`writeChain`/`mutate` 契约 |
| R24-35 | 已修 | `js/tools/qr.js`、`media/av-info.js`、`screenshot-ocr.js`、`exif-view.js`、`video-trim.js` | 各加载器新增 `loadSeq`/`probeSeq`/`analyzeSeq`，读取/探测后写 DOM 前比对；新文件进入使旧链作废 | `test-round24-fixes`：`my !== loadSeq`、`my !== probeSeq` 契约 |
| R24-36 | 已修 | `js/tools/media/audio-cut.js` | `UNIQUE_PATH` await 移入 try，异常可进 finally 复位 | `test-round24-fixes`：`UNIQUE_PATH` 必须在 try 内 |
| R24-37 | 已修 | `js/tools/media/av-convert.js`、`video-press.js`、`video-frames.js`、`img-batch.js` | CRF 0-51、fps 1-120、GIF 宽 16-4096、帧数 1-500、宽高正整数、缩放 10-500 | `test-round24-fixes`：`Math.min(51, Math.max(0` 等契约 |

### C. 可访问性、布局与 i18n（7 条）

| 编号 | 结论 | 改动文件 | 修复内容 | 测试证据 |
|---|---|---|---|---|
| R24-38 | 已修 | `js/ui.js` | modal 加 `nextId('modal-title')`、`role=dialog`、`aria-modal`、`aria-labelledby`；关闭按钮走 `makeButtonLike`；记录 opener 并在 close 恢复焦点；Tab 循环；renderTable 可排序 th/可点行补 tabindex、键盘、`aria-sort` | `test-round24-fixes`：dialog/aria-modal/opener focus/aria-sort 契约 |
| R24-39 | 已修 | `js/ui.js`、`js/cmdk.js`、`js/app.js` | toast 容器 `role=status`/`aria-live=polite`/`aria-atomic=false`，error 条目 `role=alert`；cmdk input combobox、list listbox、行 option/id/aria-selected、`aria-activedescendant`；fieldRow 补 id/label for/hint describedby；首页搜索 combobox/listbox/expanded/controls/selected | `test-round24-fixes`：aria-live/combobox/option/activedescendant 契约 |
| R24-40 | 已修 | `css/app.css` | 新增 `--success-text:#046B2A`、`--warning-text:#8A4300`、`--danger-text:#C62828`（dark 对应亮色），tag 绿/橙/红与 `.field-err`/`.status-*` 改用文本色；toast success `#036B26`、error `#B01717`、warn `#9A4A00` | `test-round24-fixes`：token/底色契约；按色值计算对比度，未做逐页人工目检 |
| R24-41 | 已修 | `css/app.css` | toast `max-width:min(480px,80vw)`、`white-space:normal`、`word-break:break-all` | `test-round24-fixes` 契约 |
| R24-42 | 已修 | `css/app.css` | 删除 `status-dot`/`spinner-lg`/`ruler-body`/`ruler-canvas`/`ruler-tip`/`chart-box`；`12.5px`→`12px` | `test-round24-fixes`：无死类、无 `12.5px`；smoke `cssRules` 498→493（来自死规则清理，非解析中断） |
| R24-43 | 部分修 | `pin.html`、`ruler.html`、`snip.html`、`js/auxwin/pin-1.js`、`ruler-1.js`、`snip-1.js`、`js/splash.js`、`main.js` | 三页补 `<html lang="zh-CN">`、pin `img alt=""`；三个 auxwin 订阅 `UI_PREFS_CHANGED` 更新 `document.lang`；channels.js 前移；splash 读取 `lang`，en 时改 lang/标题/品牌名与四个阶段文案 | `test-round24-fixes`：lang/UI_PREFS_CHANGED/splash lang 契约；smoke 辅助窗 OK |
| R24-44 | 已修 | `css/app.css` | 文件末尾加全局 `@media (prefers-reduced-motion: reduce)`：动画/过渡 0.001ms，保留 `.spinner` 无限旋转 | `test-round24-fixes` 契约 |

### D. 工程、构建与测试（7 条）

| 编号 | 结论 | 改动文件 | 修复内容 | 测试证据 |
|---|---|---|---|---|
| R24-45 | 未修 | — | release/updater 链路分叉（只构建 portable、无 `app-update.yml`/`latest.yml`/blockmap、`electron-updater` 仍生产依赖、nsis 未自动化）未改；需产品决定“补 nsis”还是“移除依赖并文档化” | 无；记录为未修 |
| R24-46 | 未修 | — | asar 排除 `node_modules/**/*.ts`、`src/**`、README 未改；需要构建产物验证，按约束本轮不构建 | 无；记录为未修 |
| R24-47 | 部分修 | `scripts/lib/features.js`、`scripts/features.json` | `chosenAll = Array.from(new Set(chosen.concat(changedTests)))`，返回 tests 改 chosenAll；`features.json` 新增 `round24` 域并登记 `test-round24-fixes.js`；9 个未登记 lib 模块清单未补齐 | `test-round24-fixes`：`chosen.concat(changedTests)` 契约；`npm run test:count` 基线含 219 文件 |
| R24-48 | 部分修 | `.github/workflows/ci.yml`、`release.yml`、`scripts/check-assertion-count.js` | CI `node --check` 改 `for f in main.js preload.js $(find lib ipc js scripts -name '*.js' -type f)`（递归）；exit-only 脚本汇总行有 `FAIL scripts/<file>` 时跳过补记；`scripts/lib/source-assert-scan.js` 递归扫描未改 | 语法自检；`test-source-assertions` 6/0；`check-assertion-count` 2499 PASS |
| R24-49 | 部分修 | `scripts/fetch-dist.js`、`fix-release-title.js`、`verify-release.js`、`hehe-toolbox.md` | `rmSync` 加 `recursive:true`；tag 正则放宽到 2-4 段；产物名必须含 `pkg.version`；文档版本/产物/提交号刷新到 0.9.7；release digest 对比未补 | `test-round24-fixes` 源码契约；`verify-release` 既有测试 |
| R24-50 | 部分修 | `scripts/test-packaged-assets.js`、`.github/workflows/release.yml` | 遍历 index/splash/snip/pin/ruler 5 个 html 的 `<script src>`；release 增加该脚本步骤；`verify-dist-round3.js` 改读 asar 未做 | `test-round24-fixes`：splash.html 契约；脚本语法自检 |
| R24-51 | 未修 | — | `jsconfig.json` 未把 `main.js`/`preload.js`/渲染层纳入 typecheck；需渐进 `checkJs` 与 `@ts-nocheck`，本轮不动 | 记录为未修；typecheck 0 只覆盖 `lib/ipc/scripts/lib` |

---

## 五、验证证据

### 5.1 代码与测试

| 命令 | 结果 |
|---|---|
| `node --check <本轮改动的 29 个 js 文件>` | 全部 OK（含 `main.js`、`lib/*`、`ipc/*`、`js/ui.js`、`js/app.js`、媒体页） |
| `npm run lint` | 0 错误 |
| `npm run typecheck` | 0 错误（覆盖范围仍为 `lib/**`、`ipc/**`、`scripts/lib/**`，见 R24-51） |
| `node scripts/test-round24-fixes.js` | **49 通过 / 0 失败** |
| `node scripts/test-powergate.js` | **89 通过 / 0 失败**（原 83，+6） |
| `node scripts/test-powergate-ps.js` | 7 / 0 |
| `node scripts/test-i18n-coverage.js` | 17 / 0 |
| `node scripts/test-channels-sync.js` | 7 / 0 |
| `node scripts/test-ipc-channels.js` | 9 / 0 |
| `node scripts/test-source-assertions.js` | 6 / 0（仅打印 `test-single-instance` 基线可收紧提示，不红） |
| `npm test` | **219 脚本 / 2499 PASS / 0 失败 / 7 环境跳过**（341.8s，exit 0） |
| `npm run test:count:write` | 统计 219 脚本 / 2499 PASS，写入 `scripts/assertions-baseline.json` |
| `npm run test:count` | 219 脚本 / 2499 PASS；`PASS 没有文件比基线少` |

- 基线变化：218 文件 / 2444 条 → **219 文件 / 2499 条**（+55：`test-round24-fixes.js` 49 + `test-powergate.js` 6）。只按实际新增上调，未下调。
- 7 个环境跳过：`test-dir-move-e2e`（无第二块可写磁盘）、`test-dir-move-impl`（无 8.3 短名）、`test-env-userenv-read`（需 `HEHE_TEST_PS=1`）、`test-acl-diagnose-e2e`（本机读不到 ACL）、`test-aux-csp`（未拿到 AUX_RESULT）、`test-file-unlock-e2e`（Restart Manager 错误码 29）、`test-ui-dpi-fixes`（真机标尺序列限制）。

### 5.2 冒烟

- 命令：`HEHE_SMOKE=1 HEHE_NOSPLASH=1 HEHE_TEST_DATA=<隔离目录>`，Electron `--no-sandbox --disable-gpu`。
- 结果：`SMOKE_RESULT: pages=111 cssRules=493 PASS`；`snip.html/pin.html/ruler.html` 均 `scripts=3, csp=on`。
- 说明：`cssRules` 由 498 降到 493，来自 R24-42 删除死 CSS 规则；冒烟阈值 250，解析完整。
- 环境限制：本机 Chromium 进程单实例锁文件创建失败（`process_singleton_win.cc` error 5），正常启动会被 `requestSingleInstanceLock` 判为“已有实例”退出。为完成冒烟，临时把该行改为 `true` 后运行，跑完用备份恢复，`main.js` SHA256 与改动前一致；仓库代码未保留该临时改动。这是测试环境限制，不是产品改动。

### 5.3 视觉/可访问性覆盖方式

- 未做逐页人工点击、Tab/读屏走查、125%/150% 缩放截图比对。
- 使用 CSS/源码契约断言锁住本轮硬伤：对话框语义与焦点恢复、表格键盘与 `aria-sort`、toast `aria-live`、cmdk/listbox、表单 label/for、首页搜索 combobox、对比度 token、长文本 toast 换行、死 CSS、reduced-motion、辅助窗 `lang`/`alt`。
- `HEHE_SMOKE=1` 真实 Electron 遍历 111 页，覆盖页面脚本异常、CSS 规则数、关键布局与三个辅助窗 CSP。

---

## 六、未修、未复现与风险

### 6.1 未复现 / 仅静态证实

| 编号 | 记录 |
|---|---|
| R24-18 | 未向真实系统 `hosts` 写入做端到端复现（避免副作用）。代码级最小探针确认 Node `copyFile` 默认跟随 reparse point；修复后 `lstat` 只接受普通文件、`realpath` 必须仍在备份目录。风险：仅代码级证实，未验证 Windows 真实 junction 场景。 |
| R24-19 | 未跑“长任务进行中退出/关主窗”的真实进程残留实测；静态确认原路径未遍历 `jobs`，现已在 `will-quit` 与主窗 `closed` 补取消。风险：运行期 detached 子进程是否立即退出未观测。 |
| R24-29 | 测速页与 ffmpeg-setup 已修；file-tools 四个一次性 `job:progress` 仍只在 finally 退订，离页到任务结束前可能写 detached DOM（任务短、无写盘副作用）。`sys-tools`/`hash` 的一次性订阅未改。 |
| R24-15 | 只夹取端口，未加一次性 token；同机进程仍可读静态服务根内文件。已在风险中保留。 |

### 6.2 未修

- R24-45：release/updater 链路分叉。当前只构建 portable，不产出 `app-update.yml`/`latest.yml`/blockmap；`electron-updater` 分支在便携版不可达，落 GitHub API。需要产品决定“补 nsis + 更新元数据”或“移除未用依赖 + 文档说明”，不适合审查轮擅自改发布链路。
- R24-46：asar 瘦身。排除 `node_modules/**/*.ts`、`src/**`、README 需要构建产物验证；本轮按约束不跑 dist、不构建，未改，避免把运行时依赖误排除。
- R24-51：`jsconfig.json` 类型检查覆盖面。`main.js`/`preload.js`/渲染层仍不在 typecheck 内；需分阶段 `checkJs` + `@ts-nocheck`，本轮不动，以免制造大量类型噪音。

### 6.3 剩余风险

- 冒烟绕过单实例锁是测试环境权宜；正常发布包仍走真实单实例锁路径，未因本轮修改。
- P3 部分项为源码契约断言，不是运行时行为断言：`ui.js`/媒体页依赖 Electron 壳，Node 测试只能锁“回归点是否接在正确位置”，行为细节由 smoke 覆盖。
- 视觉对比度按 CSS token 色值计算，未用取色器逐主题实测；Windows 高对比度模式未走查。
- `docs/copyright/` 未读取、未触碰；未提交、未 push；未跑 dist、未构建发布产物。

---

## 七、结论

- P1 电源门禁绕过已修并有 6 条新增判定 + 89 条 power-gate 回归。
- P2 九项全部落地：坏 store 四处归一、剪贴板双模态、dedupe 重入/进度串扰、dropzone 键盘、英文外壳、构建假成功、产物守卫假绿、office 离页复位、video-trim 离页暂停。
- P3 32 项全修、6 项部分修、3 项明确未修；未复现项单独记录，未当成已证实 bug。
- 收口门禁：lint 0、typecheck 0、`npm test` 219 脚本 / 2499 PASS / 0 失败、`test:count` 基线 2499 通过、`HEHE_SMOKE=1` 111 页 PASS。
