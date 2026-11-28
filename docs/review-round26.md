# 第 26 轮深度静态审查记录

- 时间：2026-11-27 凌晨（用户要求连续审查到 06:00）
- 版本：hehe-toolbox 0.9.7
- 基线提交：`979c03f`（第 24 轮收尾）；本轮全部改动留在工作区，未提交、未 push
- 约束：只做静态代码审查，不启动 Electron、不跑实机；不派子代理；`docs/copyright/` 与 `dist/` 不碰

## 一、本轮修复

### 1. Office COM 转换失败残留半截文件（main.js）

R26-01：COM 分支原先只在「`ps` 正常返回但目标文件不存在」时清理半成品。若 `ps` 本身超时/抛异常（Office 卡死、策略拦截弹窗），半截目标会留在输出目录。现在在 `catch` 里也执行 `fsp.rm(out, { force: true })`；`uniqueTarget` 保证该路径是本次新建的。

### 2. 搜索 limit 非法值导致全量/无上限扫描（main.js）

R26-02：`SEARCH.QUERY`、`CONTENT.SEARCH`、`SEARCH.QUICK`、`SEARCH.ES` 的 limit 统一改为「有限正数才采用，否则回落默认」：

- `"abc"` 不再得到 `NaN`（`i < NaN` 恒 false，实际会扫到底）
- 负数不再成为循环上限
- `SEARCH.QUERY` 的 `drive` 改为 `toUpperCase()` 查索引，`c:` 不再退回全盘遍历

### 3. 空内容搜索拒绝（main.js）

R26-03：`CONTENT.SEARCH` 在 `q` 非字符串或 trim 为空时直接报「请输入搜索内容」，避免空正则匹配整盘所有文本文件。

### 4. 内容搜索根目录读取失败时任务不收尾（main.js）

R26-04：`walkDir` 在根目录不存在/无权读取时会抛；原实现没有 `catch/finally`，job 永远留在表里、界面收不到 `done`，只能停在「正在搜索」。现在失败也发 `done + error`，并统一在 `finally` 里 `jobs.delete(id)`。搜索根由用户选择，盘符拔出、网络盘断线、权限变化都能触发。

### 5. 视频裁剪取消窗口（ipc/media-ffmpeg.js）

R26-05：`jobs.set` 之后隔着异步 `videoEncodeArgs`（硬件探测可能数秒）。用户在这段窗口点取消，原实现仍会 spawn 完整跑一遍再删成品。现在：

- 探测前先检查一次 `state.cancel`
- 探测失败时 `jobs.delete(id)`，不留幽灵任务
- spawn 前再检查一次取消

### 6. 局域网扫描并发收尾互踩（js/tools/lan-scan.js）

R26-06：旧实现 `unsub` 是整页共享变量。run1 未返回时用户再点 run2：

- run1 的 `finally` 会对共享 `unsub` 执行 `unsub()`/置 null，把 run2 刚挂上的进度监听拆掉 → run2 全程无进度
- run1 的 `finally` 无条件 `prog.hide()`，把 run2 正在显示的进度条藏掉

现在按趟保存 `myUnsub`，旧一趟只退自己那份；只有 `runToken === scanRunSeq` 时才隐藏进度条。

### 7. hosts 手动备份未并入串行锁（main.js）

R26-07：`HOSTS.BACKUP` 与 `WRITE/RESTORE` 读写同一个 hosts 与备份目录。不串行时，备份可能取到写到一半的 hosts，还原时把半截内容写回去。现已包进 `withHostsLock`。

### 8. 辅助窗首次打开不继承主窗语言（pin/snip/ruler）

R26-08：三个 `loadFile` 只传 `accent`，辅助窗不知道当前语言；`UI_PREFS_CHANGED` 只在用户再次切语言时才推，英文界面首次打开贴图/截图/标尺仍是中文提示。现在：

- main 三个 `loadFile` query 都带 `lang: uiLang`
- `pin-1.js`、`snip-1.js`、`ruler-1.js` 解析初始 `?lang=`
- `pin-2.js` 按语言替换提示
- `snip-2.js` 按语言替换工具栏按钮/线宽/调色板提示
- `ruler-2.js` 按语言替换四个 title

### 9. 实时坐标页离开后开关仍显示「开」（js/tools/dev.js）

R26-09：cleanup 只清了定时器，没有复位开关。保活复用回来时用户看到开关亮着、坐标不动，会以为功能坏了。现在 cleanup 里同时 `sw.set(false)`（`set` 不触发 `onChange`，不会反向再开定时器）。

### 10. i18n 源码断言守卫只扫顶层（scripts/test-i18n-assertions.js）

R26-10：守卫原只 `readdirSync(scripts)` 顶层，子目录里的测试整片漏检。现在递归收集 `scripts/` 下所有 `test-*.js`（跳过 `node_modules` 与点目录），用相对路径 `readSrc` 读取。

## 二、回归测试

新增 `scripts/test-round26-fixes.js`，10 条：

- R26-01 ~ R26-10 覆盖上面十项修复；能用真实实现跑的尽量跑，需要 Office/COM、hosts、窗口渲染的锁源码调用点，并逐条写明「锁的是」。

同时修正 `scripts/source-assertions-baseline.txt` 中 `test-single-instance.js` 的 B 计数 13 → 12（实际已降到 12，基线需要保持诚实）。

新增测试已登记进功能映射（`test-features-map` 通过）。

## 三、门禁与验证

- `npm run lint`：0
- `npm run typecheck`：0
- `scripts/test-round26-fixes.js`：10 通过 / 0 失败
- `scripts/test-source-assertions.js`：6 通过 / 0 失败（源码断言 1724 条，其中 1260 条已写「锁的是」）
- `scripts/test-i18n-assertions.js`：递归后 224 个测试全部通过，无「只匹配中文界面文案」的断言
- `npm run test:unit`：189 个脚本 / 2119 条 PASS，环境跳过 3 个
- `npm run test:count:write`：222 个脚本 / 2537 条 PASS，已重拍 `scripts/assertions-baseline.json`；7 个环境跳过
- `npm run test:count -- --no-run`：与基线一致，没有文件低于基线

## 四、仍未修 / 留待后续

1. **R24-45**：release 与内置 updater 两条更新路径仍存在口径分叉（electron-updater 只返回版本信息，GitHub API 路径才带 assetUrl/SHA）。当前 UI 已对无 assetUrl 的情况降级为「手动下载」，不会假成功；统一两条路径需要改更新协议，收益低于风险，未动。
2. **R24-51**：`jsconfig.json` 仍未覆盖 `main.js`、`preload.js` 与渲染层；直接纳入会产生大量既有类型错误，需要单独一轮类型清理。
3. **辅助窗实时语言切换**：R27 已补（三大辅助窗收到偏好广播后派发 `hehe-lang`，pin 提示 / ruler title / snip 工具条即时重画，见 `docs/review-round27.md`）。
4. **`HOSTS.BACKUP` 行为验证**：已并入同一把锁，但真实 hosts 写入需要管理员权限，未做本机实测。
5. **UI 固定宽度**：R25 已逐项核对设置导航、modal、环境管理、文件工具、启动页；本轮未发现新的溢出，仍建议用真实窗口截图复核 560px 工具窗。

## 五、范围声明

- 未做手工实机验收/交互；仅执行仓库既有自动化门禁（其中部分 UI 用例会拉起 Electron，属于测试本身）。
- 未派子代理。
- 未提交、未 push；所有改动留在工作区待验收。
- 未触碰 `dist/` 与 `docs/copyright/`。
