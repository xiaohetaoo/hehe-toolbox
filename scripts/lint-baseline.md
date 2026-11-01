# ESLint 存量问题基线

> 由 `scripts/gen-lint-baseline.js` 生成。**不要手改**，改完 lint 后重跑该脚本。

本文件登记的是本轮**不修**的既有问题。每一条都在源码里用**行级**
`/* eslint-disable-next-line <规则> -- 理由 */` 压制，而不是文件级 disable ——
文件级会让整个文件永不再被检查，以后真的 bug 也抓不到。

## 为什么登记而不是一次全修

这些是项目既有的写法，不是本轮改造引入的。一次全修会同时动几十个文件，
与「不许改任何用户可见行为」的约束冲突。登记是为了：

1. 让 lint 能进 CI 而不制造噪音（否则必然有人批量加 disable 把它压成假绿）；
2. 让后来者知道「这些行是已知的、有理由的」，不是漏网的真 bug；
3. 给下一轮清理一张明确清单。

## 总数：74 处

| 规则 | 处数 | 性质 |
|---|---|---|
| `no-unused-vars` | 50 | 解构了未使用的助手 / 局部变量赋值后未使用。**多数无害**（多解构几个助手是常见写法），少数是旧实现残留。 |
| `no-shadow` | 21 | 内层同名变量。已逐条人工确认无语义影响。（`catch (e)` 嵌套属正常写法，已从规则里排除，这里剩的是真同名遮蔽。） |
| `no-async-promise-executor` | 3 | `new Promise(async (resolve, reject) => ...)`。**这一条最值得下一轮处理**：async executor 里抛出的异常不会走 reject，而是变成未捕获的 rejection。 |

## 明细


### `no-unused-vars`（50 处）

- `js/app.js:3` — 'fmtBytes' is assigned a value but never used.
- `js/app.js:23` — 'dangerousCaps' is assigned a value but never used.
- `js/auxwin/pin-2.js:7` — 'scale' is assigned a value but never used.
- `js/auxwin/snip-1.js:17` — 'accentPrimary' is defined but never used.
- `js/auxwin/snip-2.js:4` — 'W' is assigned a value but never used.
- `js/tools/convert.js:4` — 'toast' is assigned a value but never used.
- `js/tools/convert.js:89` — 'local' is assigned a value but never used.
- `js/tools/convert.js:248` — 'i' is assigned a value but never used.
- `js/tools/dev.js:4` — 'renderTable' is assigned a value but never used.
- `js/tools/dev.js:16` — 'rows' is assigned a value but never used.
- `js/tools/dev.js:379` — 'running' is assigned a value but never used.
- `js/tools/disk-health.js:4` — 'toast' is assigned a value but never used.
- `js/tools/file-tools.js:317` — 'tab' is assigned a value but never used.
- `js/tools/file-tools.js:833` — 'engines' is assigned a value but never used.
- `js/tools/hash.js:4` — 'toast' is assigned a value but never used.
- `js/tools/json-regex.js:4` — 'renderTable' is assigned a value but never used.
- `js/tools/json-regex.js:17` — 'lastValid' is assigned a value but never used.
- `js/tools/launch.js:4` — 'fmtDate' is assigned a value but never used.
- `js/tools/launch.js:45` — 'i' is assigned a value but never used.
- `js/tools/life.js:4` — 'confirmBox' is assigned a value but never used.
- `js/tools/media/shared.js:52` — 'samePath' is defined but never used.
- `js/tools/media/shared.js:56` — 'pickPaths' is defined but never used.
- `js/tools/media/screen-rec.js:111` — 'paused' is assigned a value but never used.
- `js/tools/media/video-frames.js:38` — 'base' is assigned a value but never used.
- `js/tools/net-tools.js:91` — 'running' is assigned a value but never used.
- `js/tools/office.js:4` — 'fmtBytes' is assigned a value but never used.
- `js/tools/security.js:4` — 'renderTable' is assigned a value but never used.
- `js/tools/security.js:246` — 'i' is assigned a value but never used.
- `js/tools/sys-tools.js:4` — 'copyText' is assigned a value but never used.
- `js/tools/sys-tools.js:755` — 'mode' is assigned a value but never used.
- `js/tools/target-size.js:17` — 'isDesktop' is assigned a value but never used.
- `js/tools/target-size.js:122` — 'refreshList' is defined but never used.
- `js/tools/text-codec.js:4` — 'copyText' is assigned a value but never used.
- `js/tools/text-codec.js:35` — 'origConvert' is assigned a value but never used.
- `js/tools/text-tools.js:156` — 'conf' is assigned a value but never used.
- `js/tools/text-tools.js:496` — 'r' is assigned a value but never used.
- `js/ui.js:3` — 'on' is assigned a value but never used.
- `lib/acl-repair.js:98` — 'MULTIWORD_PRINCIPALS' is assigned a value but never used.
- `lib/dir-move.js:22` — 'path' is assigned a value but never used.
- `lib/links.js:139` — 'st' is assigned a value but never used.
- `lib/path-guard.js:120` — '_legacyCriticalDirs' is assigned a value but never used.
- `lib/rm-lockers.js:1` — 'fs' is assigned a value but never used.
- `lib/rm-lockers.js:2` — 'path' is assigned a value but never used.
- `main.js:1968` — 'isPowerCommand' is defined but never used.
- `main.js:2033` — 'latestCancelable' is assigned a value but never used.
- `main.js:2695` — 'r' is assigned a value but never used.
- `main.js:2756` — 'backedUp' is assigned a value but never used.
- `main.js:2897` — 'bh' is assigned a value but never used.
- `main.js:5667` — 'ctx' is assigned a value but never used.
- `main.js:6358` — 'ARCHIVE_JOB_LIMITS' is assigned a value but never used.

### `no-shadow`（21 处）

- `js/app.js:149` — 'on' is already declared in the upper scope on line 4 column 19.
- `js/app.js:558` — 'on' is already declared in the upper scope on line 4 column 19.
- `js/registry.js:204` — 'modName' is already declared in the upper scope on line 21 column 12.
- `js/tools/dev.js:294` — 'i' is already declared in the upper scope on line 280 column 18.
- `js/tools/launch.js:155` — 'items' is already declared in the upper scope on line 144 column 15.
- `js/tools/life.js:293` — 'items' is already declared in the upper scope on line 287 column 15.
- `js/tools/life.js:303` — 'items' is already declared in the upper scope on line 287 column 15.
- `js/tools/media/video-frames.js:46` — 'r' is already declared in the upper scope on line 1578 column 15.
- `js/tools/net-tools.js:266` — 'r' is already declared in the upper scope on line 247 column 15.
- `js/tools/net-tools.js:267` — 'r' is already declared in the upper scope on line 247 column 15.
- `js/tools/net-tools.js:269` — 'r' is already declared in the upper scope on line 247 column 15.
- `js/tools/net-tools.js:270` — 'r' is already declared in the upper scope on line 247 column 15.
- `js/tools/office.js:189` — 'page' is already declared in the upper scope on line 162 column 12.
- `js/tools/office.js:243` — 'page' is already declared in the upper scope on line 210 column 12.
- `js/tools/security.js:184` — 'list' is already declared in the upper scope on line 163 column 13.
- `js/tools/sys-tools.js:66` — 't' is already declared in the upper scope on line 18 column 15.
- `js/tools/sys-tools.js:573` — 'on' is already declared in the upper scope on line 5 column 19.
- `js/ui.js:177` — 'placeholder' is already declared in the upper scope on line 738 column 12.
- `js/ui.js:545` — 'btn' is already declared in the upper scope on line 682 column 12.
- `lib/target-size.js:60` — 'totalKbps' is already declared in the upper scope on line 39 column 9.
- `main.js:6917` — 'ps' is already declared in the upper scope on line 227 column 10.

### `no-async-promise-executor`（3 处）

- `js/tools/media/shared.js:20` — Promise executor functions should not be async.
- `js/tools/target-size.js:27` — Promise executor functions should not be async.
- `main.js:3042` — Promise executor functions should not be async.

## 本轮真修掉的问题（不是压制，是改代码）

| 位置 | 规则 | 问题 | 修法 |
|---|---|---|---|
| `js/tools/launch.js` | no-undef | `pickOne` 定义在第一个工具的作用域内，第二个工具（命令收藏）跨作用域引用 → 点「➕ 收藏命令」填完内容后直接 ReferenceError，选择执行环境的弹窗根本不出现 | 把 `pickOne` 提到模块顶层 |
| `js/tools/media/exif-view.js` | no-undef | `parseTiff` 定义在 `parseExif` 外面，却直接引用 `parseExif` 的形参 `buf` → **带 EXIF 的照片反而看不到参数**（异常被 catch 吞成「未找到 EXIF 信息」），没有 EXIF 的照片却正常 | `parseTiff(buf, start)` 显式传参（任务 9 拆文件后位于 exif-view.js） |

> 这两处都是 ESLint 的 `no-undef` 抓出来的 —— 语法检查（`node --check`）与所有单元测试都看不见它们，
> 因为出错路径只在特定输入（命令收藏页 / 带 EXIF 的照片）下才会走到。

## 本轮撤掉的压制（注释比问题活得久）

| 位置 | 原来的压制 | 为什么撤掉 |
|---|---|---|
| `js/tools/media/screen-rec.js` | `no-shadow` | ESLint 报「Unused eslint-disable directive」：**那里根本没有遮蔽**。`window.api` 解构出的 `on` 与录制页局部 `const on` 不在同一作用域链上，规则本来就不会触发。这条压制是早期批量加注释时顺手多挂的，它唯一的作用是让 baseline 的计数虚高。撤掉后 `no-shadow` 从 22 处降到 21 处，总计数 75 → 74。

## 任务 9 拆分后行号的位置变化

`js/tools/media.js`（1803 行、16 个工具）已按 register 边界拆成
`js/tools/media/*.js` 的 17 个文件。上面 6 条压制随代码一起搬到了新文件，
**处数与规则都没变**（仍是 74 处），只是路径与行号换了。
`gen-lint-baseline.js` 的文件清单同步改成了 `js/**/*.js`（递归） ——
否则拆分后它会漏掉 `js/tools/media/` 下的文件，把 media 这 6 条当成
「问题没了」，本文件就会被写少一截。

## 生成脚本自身的一道闸（不是压制，是防止文档被静默清空）

`scripts/gen-lint-baseline.js` 的流程是「还原 `*.lintbak` → 重新收集 → 重新插入 → 重写本文件」。
它依赖 `*.lintbak` 里存着**压制之前**的源码。备份一旦不在（被用掉、或上一次已还原过），
restore 变成空操作，收集阶段拿到的就是**已经压制过的代码** —— ESLint 一条问题都报不出来，
本文件被重写成「总数：0 处 + 空明细」，而 `npm run lint` 依然退出码 0。
**本轮真的踩了一次**：git 里那份 121 行的文档被覆盖成十几行，没有任何自动化信号。
现在该脚本在找不到任何备份时直接 `exit 2` 并说明原因，不写文件。

