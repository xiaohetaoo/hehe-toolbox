# 第 21 轮深度审查（2026-11-25 凌晨，未提交）

范围：`js/tools/*` 与 `js/tools/media/*` 的输出目录推导、`js/ui.js` 文件列表、`main.js` 的 TTS 长度上限与自启备份、`lib/path-text.js`、`lib/env-path.js`、`js/tools/launch.js`、`js/tools/security.js`、`scripts/test-dir-move-impl.js`。本轮共修复 **7 项**（含 1 项测试稳定性）。

## 一、修复清单

| # | 级别 | 位置 | 问题 | 修复 |
|---|------|------|------|------|
| 1 | P2 | `js/tools/office.js`、`file-tools.js`、`chain.js`、`target-size.js`、`sys-tools.js`、`media/img-batch.js`、`img-compress.js`、`av-convert.js`、`img-stitch.js`、`img-watermark.js`、`video-press.js`、`js/ui.js` | 渲染层 10 处各写一份 `p.replace(/[\\/][^\\/]*$/, '')`：`C:\foo` 得到 `C:`（盘符相对路径），顶层文件、盘符根、Office/图片批处理默认输出目录、系统工具“上一级”都会算错；目录带尾斜杠时 basename 为空 | 新增 UMD `lib/path-text.js`（`dirname/basename`），`index.html` 紧跟 `lib/safe-name.js` 加载；上述页面统一走 `window.PathText`，`ui.js` 的显示用 helper 也改走它 |
| 2 | P2 | `main.js` `TTS.SPEAK/WAV` | 渲染层已拦 5000 字，但 IPC 本身没有上限；直接调用可把上万字一次塞给 PowerShell 语音引擎，主进程被锁到念完，内存和“停止”响应都不可控 | 两个 handler 都在入口校验 `length > 5000`，明确报错“请分段”；仍保留 `ttsInt` 夹取 |
| 3 | P3 | `main.js` `AUTOSTART.DELETE/ENABLE/DISABLED_LIST` | `autostartBackup` 被手改成 `null`/对象时，disable 的 `.find` 直接抛；enable 在 `reg add` 已成功后才 `.filter` 抛，界面显示“启用失败”，实际已经启用 | 三处统一 `Array.isArray(cur) ? cur : []`；enable 过滤时再排除空项 |
| 4 | P3（测试） | `scripts/test-dir-move-impl.js` | 长路径用例用 `'x'.repeat(70)` 拼 260 条路径；在 `os.tmpdir()` 稍短的机器上总长 32539，低于 Windows 32767 上限，测试不再触发“分批”分支而误报 | 改为 `repeat(100)`，总长稳定超过 32767；文件只改 2 行，不动 CRLF |
| 5 | P3 | `lib/env-path.js` | `prependEntries` 用 `s.replace(/[\\/]+$/, '')` 去尾分隔符，把 `C:\` 写成 `C:`。PATH 里的 `C:` 是“C 盘当前目录”，不是盘符根；用户在环境管理里选中驱动器根时会走到这条 | 新增 `stripTrailingSep`：盘符根保留成 `C:\`，普通目录照旧去尾斜杠；EP6 行为测试 |
| 6 | P3 | `js/tools/launch.js` | `quicklaunch`/`commands` 的 store 被手改成对象或字符串后，load 的 `items.entries` 抛、add 的 `items.push` 抛、删除的 `findIndex` 抛；用户看到“一条都没有、点添加报收藏失败”，只能删数据文件 | 读、加、删三处统一 `Array.isArray(raw) ? raw : []`；S12 锁住五处兜底 |
| 7 | P3 | `js/tools/security.js` | `clipHistory` 被手改成对象/字符串后，`load` 把非数组交给 `sweepSensitive`/`render`，`filter` 抛；下次复制时 `history.unshift` 也抛，历史页空白且不再记录 | load 统一 `Array.isArray(raw) ? raw : []`；S13 锁住兜底 |

## 二、新增 / 修改的测试

- `scripts/test-path-text.js`（新建，4 条）：顶层文件/盘符根、普通与尾斜杠目录、`/` 与 UNC 根、basename。
- `scripts/test-env-path.js`：EP6 锁盘符根不能退化成 `C:`。
- `scripts/test-round20-fixes.js`：S6b 补“WAV/SPEAK 的 IPC 长度上限”；S11 锁自启备份三处数组兜底；S12 锁快捷启动/命令收藏五处数组兜底；S13 锁剪贴板历史数组兜底。
- `scripts/test-dir-move-impl.js`：长路径重复次数 70→100。
- `scripts/features.json`：登记 `lib/path-text.js`；`test-path-text.js` 由 `test-path-*` 通配覆盖。

## 三、验证记录

- `node scripts/test-path-text.js`：4 通过 / 0 失败。
- `node scripts/test-round20-fixes.js`：14 通过 / 0 失败。
- `node scripts/test-env-path.js`：6 通过 / 0 失败。
- `node scripts/test-source-assertions.js`：6 通过 / 0 失败（新增断言都写了“锁的是”）。
- `npm test`：**216 脚本 / 2430 PASS / 0 失败 / 7 环境跳过**（349.7s，exit 0）。
- `npm run lint`：0；`npm run typecheck`：0（`PathText` 挂 window 时用局部 `@type {any}` 变量绕开 Window 接口未扩展的问题）。
- `npm run test:count:write`：total=**2430**（216 文件）；`npm run test:count`：PASS。
- `HEHE_SMOKE=1`（隔离 userData + `--no-sandbox --disable-gpu`）：`pages=111 cssRules=498 PASS`；`snip.html/pin.html/ruler.html` 均 `scripts=3, csp=on`。

环境跳过仍为 7 个：`test-dir-move-e2e.js`、`test-dir-move-impl.js`、`test-env-userenv-read.js`、`test-acl-diagnose-e2e.js`、`test-aux-csp.js`、`test-file-unlock-e2e.js`、`test-ui-dpi-fixes.js`。

## 四、明确没做的事 / 遗留

- 没有逐页人工点击 111 个工具页；冒烟覆盖页面脚本异常、CSS 规则数与关键布局，真实拖拽、右键菜单、系统文件选择器仍未人工复核。
- `PathText` 未专门处理 `\\?\C:\` 扩展长度前缀的盘符根（当前只兜普通 `C:`）；渲染层拿到的选择器路径通常不带前缀，主进程长路径逻辑另有处理，暂不扩大。
- `AUTOSTART.DELETE/ENABLE` 仍信任渲染层传入的 `item.key/name/cmd`，与第 20 轮判断一致：渲染层已有 `EXEC.STREAM`，这层不构成新的权限边界。
- 全部改动仍在工作区，未提交、未 push。
