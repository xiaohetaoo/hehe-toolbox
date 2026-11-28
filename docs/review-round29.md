# 第 29 轮深查记录（2026-11-28 凌晨，未提交）

## 背景

第 28 轮收口后，用户要求继续深查并工作到 06:00。本轮仍只做静态审查与自动化验证，不手工启动应用，不派子代理。

## 确认问题：网速测试页保活复用后永久失效

`js/tools/net-tools.js` 的「网速测试」页把 `disposed` 当作“页面已离开”的布尔量：

- `App.onCleanup` 里 `disposed = true`，切走时退订并 KILL 当前任务；
- 但页面会被 `keepAlive` 复用，切回来没有 `onEnter` 把 `disposed` 复位；
- 结果：按钮看起来可点，`run()` 第一行 `if (disposed) return` 直接静默返回；若切走时正在测速，`finally` 还因 `disposed` 不恢复按钮，页面回来就是灰的。

同时存在第二个窗口：一旦简单地把 `disposed` 复位，上一轮还没返回的 `NET.SPEEDTEST` 会把旧速度写进刚切回来的页面；旧轮的 `job:stream` 也可能把旧样本画到新曲线，旧轮 `finally` 还会误退新轮的订阅、误点亮按钮。

## 修复

1. 保留 `disposed`，只负责“隐藏页不写界面”；新增 `speedRunSeq` 作为每轮测速序号。
2. `onCleanup`：`disposed = true`、`speedRunSeq++`、退订、KILL、清空状态行。
3. 新增 `App.onEnter`：`disposed = false`，恢复两个按钮可点；旧轮由序号判废。
4. `run()`：`const myRun = ++speedRunSeq;`；流事件先判 `myRun !== speedRunSeq || disposed`，过期轮若刚认领到 id 立即 KILL；`await` 返回与 `catch` 都按序号判废。
5. `finally` 只在 `myRun === speedRunSeq` 时退订、清 `speedJobId`；只在 `myRun === speedRunSeq && !disposed` 时恢复按钮。旧轮不再碰当前轮的 UI 与订阅。

## 第二处：工具链离开页面后仍会启动下一步

`js/tools/chain.js` 的页面 cleanup 只递增 `chainRunSeq`，但 `runChain()` 原来不接收任何停止判据：

- 用户切走后，当前步骤会继续跑完；
- 更关键的是，当前步骤结束后它还会继续启动下一步，整条链可能把剩余文件全部改完；
- 页面回来之前，`runBtn` 一直灰着，用户既看不到进度也无法停。

修复：`runChain(chain, files, onProgress, shouldStop)` 在**每个步骤开始前**检查判据；命中时返回 `{ state, outputs: cur, canceled: true }`，不再启动下一步。UI 传入 `() => runToken !== chainRunSeq`。

限制：正在执行的单步没有取消通道（IPC 操作没有统一 abort），所以当前步骤会跑完；本轮保证的是“不再继续下一步”，不是“立即中断当前步”。

## 测试

新增 `scripts/test-round29-fixes.js`，7 条静态接线断言：

- R29-01 onEnter 复位 `disposed` 与按钮；
- R29-02 cleanup 递增轮次，`run` 领号，返回后判废；
- R29-03 流事件按轮次过滤；
- R29-04 旧轮 `finally` 不恢复当前轮按钮；
- R29-05 `runChain` 接收停止判据并在步骤边界返回 `canceled`；
- R29-06 UI 把页面序号作为停止判据传进去；
- R29-07 旧轮进度回调在切页后不再写进度行。

这七条无法用行为断言替代：`run()` 依赖真实 Electron `window.api`、`job:stream` 与 10 秒联网测速，测试环境无法稳定重放“切页后旧 await 才返回”的时序；`runChain` 的各操作又依赖真实 IPC/磁盘。因此锁源码接线，并在断言上方写明锁的是哪个回归。

## 门禁

- `npm run lint`：0
- `npm run typecheck`：0
- 完整 `npm run test:count:write`：**226 个脚本 / 2562 条 PASS**
- `npm run test:count -- --no-run`：通过，无文件低于基线
- `node scripts/test-source-assertions.js`：6/6 PASS；源码断言 1795 条，1331 条已写“锁的是”
- `node scripts/test-i18n-assertions.js`：228 条 PASS
- `node scripts/test-round29-fixes.js`：6/6 PASS

7 个环境脚本仍按既有原因跳过，与第 28 轮相同。

## 范围

代码改动仅 `js/tools/net-tools.js`、`js/tools/chain.js` 与新增测试/记录；未 commit、未 push；`docs/copyright/` 与 `dist/` 未触碰。
