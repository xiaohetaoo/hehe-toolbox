# 第 19 轮深度审查记录（2026-11-24 深夜）

> 本轮目标：继续逐行审查，按收益降序修完发现的问题；覆盖 UI 一致性与真实启动检查。
> 范围：`ipc/fs-ops.js`、`ipc/media-ffmpeg.js`、`ipc/dir-acl-links.js`、`ipc/env-manager.js`、`ipc/net-lan.js`、`ipc/ctx.js`、`lib/*` 纯逻辑、`main.js` 的可疑路径、`index.html` 的脚本加载顺序。
> 约束：不 push、不上传；改动留在工作区。测试以仓库自带套件 + 独立 Electron 启动（隔离 userData）为准。

## 一、按收益排序的问题与修复

| 收益 | 问题 | 位置 | 处理 |
|---|---|---|---|
| P0 | 电源门禁只认「可执行位首词」，`schtasks /create /tr "shutdown /s"`、`at 23:59 shutdown /s`、`Invoke-CimMethod -MethodName Shutdown`、`(Get-WmiObject ...).Win32Shutdown(2)`、`New-ScheduledTaskAction -Execute shutdown` 全部绕过 —— 用户以为高危功能已拦住，实际仍能关机 | `lib/power-gate.js` | 增加 `SCHEDULER_HEADS`、`WMI_METHOD_HEADS`、`POWER_VERB_RE`、`.win32shutdown(` 判据，`psshutdown` 加入危险词；`schtasks /query`、`/end` 不误拦 |
| P1 | 渲染层两份 lib 在**同一个全局词法环境**里各写 `const API` / `const root`：后加载的 `run-token.js` 整份脚本 SyntaxError，`window.RunToken` 永远不存在，每次启动控制台报错 | `lib/run-token.js`、`lib/img-pick.js` | 顶层标识符改为模块专属前缀（`RunTokenApi` / `tokenRoot`、`ImgPickApi` / `imgPickRoot`）；新增测试在共享 vm 上下文按 index.html 顺序真实加载 |
| P1 | `path-guard` 把「Users 本身 + 一层」的豁免套到了别人 home 深处：`C:\Users\Alice\Documents` 及更深可被递归删除/覆盖 | `lib/path-guard.js` | 新增 `usersBoundary()` / `inOtherUserHome()`，`checkDeletable` 与 `checkOverwritable` 都拦 `OTHER_HOME`；自己的 Documents 继续放行 |
| P1 | 磁盘空间扫描传入**相对路径**（输入框手打）时，聚合键是绝对 `scanRoot`、遍历出的 `item.path` 是相对路径，逐目录体积全部为 0（实测 `total 800000 / topDirs size 0`） | `ipc/fs-ops.js`（`SCAN_TREE`） | `walkDir(scanRoot, ...)`，不再用原始 root |
| P1 | 空目录扫描/查重同样返回相对路径，渲染层原样送回 `fs:delete-empty` / `fs:delete` 时按主进程 cwd 解析，一个也删不掉 | `ipc/fs-ops.js`（`SCAN_EMPTY_DIRS` / `DEDUPE`） | 两处统一用 `scanRoot` 遍历并返回绝对路径 |
| P1 | 文件分割的换片判据用 `ws.bytesWritten`（已落盘字节，不含写队列）；慢盘/杀软扫描时同一片会多塞 chunk，选 1MB 可能拿到 2MB 片 | `ipc/fs-ops.js`（`SPLIT_FILE`） | 改为本地 `partBytes`（随 write 递增、开新片重置），条件 `partBytes >= chunkSize` |
| P1 | 录制「停止」在没有分段时提前 `return`，绕过 `try/finally`，`recOpts/recSegDir/recOwner` 残留；下次开始录制被「已有录制会话进行中」挡住，只能重启应用 | `ipc/media-ffmpeg.js`（`REC.STOP`） | 早退分支补完整复位并清掉空分段目录 |
| P1 | FFmpeg 下载解压、手动挑选、备用名三处**直接写坏 bin/ffmpeg.exe**；写到一半失败会留下半截 exe，而检测只看「文件存在」，之后所有转码失败 | `ipc/media-ffmpeg.js` | 三处统一 `tempNames.writeTmp` + rename，失败清理临时名；gz 临时文件改 `try/finally` 清理 |
| P1 | 目录搬家预检的链接清单有 20 万条上限；截断后复制阶段仍跳过所有链接，恢复清单只来自预检 —— 目标侧少链接且**全流程不报错** | `ipc/dir-acl-links.js` | 复制阶段把实际遇到但不在 skip 集合的链接记入 `stats.links`，与预检按小写路径去重合并；判定/重建/emit 全用合并清单 |
| P1 | 测速可永久挂起：下行只在「收到数据」时检查时长，服务器接受连接后不发数据就永远等；上行 `fetch` 无超时 | `ipc/net-lan.js` | `seconds` 夹到 1..120（防 Infinity 立刻超时），加独立 `hardStop` 硬超时并 `ctrl.abort()`；catch 区分超时文案，`finally` 清理定时器 |
| P1 | 解锁进程名未归一：Restart Manager 返回 `svchost.exe` 或带完整路径的 `lsass.exe` 时比较不上关键进程名单，可被结束 | `lib/unlock-safety.js` | 去目录、去 `.exe`、trim/lower 后再比对；`WINWORD.EXE` 仍放行 |
| P1 | 剪贴板图片动作（截图标注/OCR/图片压缩）把 `dataUrl` 塞进 `__pendingDrop`，但 `takePending` 只返回 `paths/exts`、`filePicker` 也只认路径 —— 图片内容在交接时静默丢失，工具页是空的 | `js/app.js`（`consumePendingClip`） | 先调已有的 `clip:save-image` 落成 `userData/clip-img` 下的临时文件，再把返回路径放进 `paths`；临时图有孤儿清理 |
| P1 | 冒烟布局断言用字符串全等比 px：Windows 125% 缩放下 Chromium 报 `37.9921px` / `179.995px`，正确布局被判 LAYOUT 失败（实测本机命中） | `main.js` 冒烟探针 | 增加 `pxNear`（数值差 ≤0.5px），`expect` 与卡片图标检查共用；display 等非数值仍全等 |
| P2 | 计算/表达式里常量后写百分号（`pi%`、`e%`）被当成取余，parser 报「表达式不完整」 | `lib/expr-eval.js` | `prevIsOperandEnd` 纳入 `const` 类型 |
| P2 | 剪贴板动作面板的空态/路径属性两屏没有 `onClose`：按 Esc/点遮罩关闭后 `modalEl` 仍指向已销毁实例，下一次 Ctrl+Shift+V 走「再按一次就收起」，面板打不开 | `js/clip-actions.js` | 两处补 `onClose: () => { modalEl = null; }` |
| P2 | 图片剪贴板的第一推荐动作是「截图标注」，但 `snip-tool` 只能框选屏幕、没有导入图片入口 —— 点进去是空白截图页，用户以为动作没生效 | `lib/clip-analyze.js` | 图片与 base64 图片的动作表移除 `imgAnnotate`，改为 OCR / 压缩 / 贴图 / 保存；同步更新 `test-clip-analyze` 断言 |
| P3 | 测速 handler 解构默认参数导致 tsc 推断成 `{seconds?:number}`，`direction/url` 报 TS2339（R19 改动后暴露） | `ipc/net-lan.js` | 改 `opts` + 显式 `@type` 注解，行为不变 |
| P3 | 首页搜索框 `Ctrl K` 小胶囊圆角 5px，与全站 4/6/8/10 刻度不一致 | `css/app.css`（`.hs-kbd`） | 5→4px |

合计 **18 项**：P0 1、P1 12、P2 3、P3 2。

## 二、测试与基础设施

| 文件 | 内容 |
|---|---|
| `scripts/test-lib-globals.js`（新） | L1 用共享 vm 上下文按 index.html 顺序真实加载 lib 脚本；L2 断言 `SafeName/ImgPick/RunToken/OcrGuard` 都挂到 window；L3 静态扫描全部脚本的顶层 `const/let/class`，禁止跨文件重名 |
| `scripts/test-round19-fixes.js`（新） | S1–S13：扫描根归一、分片字节计数、REC.STOP 复位、ffmpeg 原子写、目录搬家合并链接、OTHER_HOME、电源计划任务/WMI、测速硬超时、常量百分号、冒烟 px 容差、剪贴板弹窗复位、剪贴板图片先落盘 |
| `scripts/lib/fs-handlers.js`（新） | 用真实 `register(ctx,deps)` 把 fs handler 装进 Map，供行为测试直接调用（避免「抽函数体 + new Function」引用模块级助手时变 undefined） |
| `scripts/test-split-stream.js`（改） | 13c：2.5MB → 1MB/1MB/0.5MB，校验 manifest 的 parts/size（真实跑流，不只读源码） |
| `scripts/test-scan-tree.js`（改） | 17d 相对根逐目录体积/绝对路径；17e 空目录扫描 + 查重绝对路径；文件级 `serialAsync` 串行链（避免两个用例各自 `process.chdir` 互相改走 cwd） |
| `scripts/test-powergate.js`（改） | mustBlock +8（计划任务/WMI/psshutdown）、mustAllow +4（`schtasks /query`、`/end` 等） |
| `scripts/test-path-guard.js`（改） | 新增 25e（别人 home 深处拒绝删除/覆盖）；原「允许覆盖普通文件」改用 `os.homedir()` 构造，避免被新规则正确拦下 |
| `scripts/test-file-unlock-release.js`（改） | +3：`svchost.exe`、带路径 `lsass.exe` 拦住，`WINWORD.EXE` 放行 |
| `scripts/test-expr-eval.js`（改） | 新增 30：`pi%`、`e%`、`2*pi%` |
| `scripts/test-drop-keepalive.js`（改） | KA7 原断言锁住了「`paths: []` + `dataUrl`」这种会丢图的旧交接；改写为「先 `SAVE_IMAGE` 落盘、再把 `r.path` 放进 `paths`」 |
| `scripts/test-clip-analyze.js`（改） | 图片动作不应包含无法导入图片的 `imgAnnotate`；保留 OCR / 压缩断言 |

## 三、验证记录

- `npm test`（最终改动之后）：**213 脚本 / 2403 PASS / 0 失败 / 7 环境跳过**，352.0s，exit 0。
  - 与 R18 结束时的 211/2374 相比：新增 `test-lib-globals.js`（3 条）、`test-round19-fixes.js`（13 条）、`test-split-stream` 13c、`test-scan-tree` 17d/17e、`test-drop-keepalive` KA7 改写等。
  - 中间一次全量曾暴露 2 处**由本轮新增文件/调用**引起的门禁失败，均已修正：`test-features-map` 要求新测试登记功能域（已加入 core），`test-temp-names` 的 17 号「裸 rename 清单」不认识 FFmpeg 挑选分支的 `fsp.rename(tmp2, dest)`（已登记并注明同目录同卷）。
  - 另有一处**旧测试锁住了旧缺陷**：`test-drop-keepalive` 的 KA7 原断言要求「`paths: []` + `dataUrl`」这种实际会丢图的交接；已改写为「先 `SAVE_IMAGE` 落盘、再把 `r.path` 放进 `paths`」，与修复后的实现一致。
- `npm run test:count:write`：统计 **2403** 条并写入 `scripts/assertions-baseline.json`（213 文件；7 个环境跳过脚本使计数偏保守）。
- `npm run lint`：0 问题；`npm run typecheck`：exit 0（本轮修掉了 `ipc/net-lan.js` 参数解构引发的 TS2339）。
- 真实 Electron 检查（隔离 userData + `--no-sandbox`，不碰正式配置）：
  - `HEHE_SMOKE=1` 遍历 **111 个工具页**：`pages=111 cssRules=498 PASS`，三个辅助窗（snip/pin/ruler）CSP 正常，渲染进程无 error/warning。
  - 截图人工目检首页、设置、图片压缩、压缩解压、文本统计 5 页；首次启动控制台抓到 `Identifier 'API' has already been declared`，修复后复跑不再出现。
- 临时产物已清理：`.tmp-*` 探针/截图/测试日志、项目根 `shot-*.png`、`diag-shot.png` 均删除。

## 四、明确没做的事（避免误读）

- 未做逐页人工点击：111 个工具页由 `HEHE_SMOKE=1` 的真实 Electron 遍历覆盖（页面脚本异常、CSS 规则数、关键布局），另有 5 页截图人工目检；手势、拖拽、真实 ffmpeg 输出仍建议实机复核。
- 未提交、未 push：全部改动留在工作区。
- `main.js` 5321 行仍未逐行通读，只按函数导航检查窗口加固、hosts、更新、剪贴板/截图清扫等高风险路径；`ipc/env-manager.js`、`ipc/ctx.js` 与剩余小型 lib 已读，未发现需要改动的问题。

## 五、遗留观察（未修，理由）

1. `lib/temp-names.js` 的 `writeTmp(dest, tag)` 仍是「同目录 + 固定 tag」：同一目标同一 tag 的并发原子写会撞名。当前只有 FFmpeg 下载/更新替换使用，天然单飞；改成随机后缀会牵动清理白名单与基线的正则，收益低于风险。
2. `main.js` 的 `uniqueTarget(root, rel)` 仍是「循环查存在再给名」，多窗口并发同名导入有极窄竞态窗口；`lib/fs-ops.js` 的 `placeUnique` 才是原子写法，但迁移涉及所有批量导入路径，未在本轮扩大改动面。
3. `index.html` 仍有 80 个经典脚本共享全局环境。L3 已锁住当前无重名，但长期更稳的做法是逐步改成 ES module 或全部 IIFE；一次性改造风险高，未动。
