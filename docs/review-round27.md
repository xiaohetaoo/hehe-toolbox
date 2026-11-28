# 第 27 轮：辅助窗实时语言 + 测速上行响应上限 + 局域网扫描进度隔离

- 日期：2026-11-27 凌晨（未提交、未 push）
- 承接：R26 连续深查。R26 已修 10 项；本轮继续按收益降序，只处理确认问题。
- 约束：静态审查为主；不手工跑实机；未派子代理；未触碰 `dist/`、`docs/copyright/`。

## 一、修复

### R27-1 辅助窗已打开时切语言不更新文案
R26 只让 `pin/snip/ruler` 首次打开时从 `loadFile` 的 `lang` 参数继承语言。窗口已经开着时，`UI_PREFS_CHANGED` 只改 `document.documentElement.lang`，DOM 逻辑不会重画，于是：

- 贴图窗提示仍是旧语言；
- 标尺四个 `title` 仍是旧语言；
- 截图工具条的 `title/aria-label`、调色板提示、线宽提示仍是旧语言。

修法：

- `pin-1.js` / `ruler-1.js` / `snip-1.js` 收到偏好广播后，先 `setLang()`；只有语言真的变了才派发 `hehe-lang`（主题/主色广播也会走同一事件，不加判断会让截图工具条无谓重建）；
- `pin-2.js` 抽出 `applyHintLang()`，监听事件即时换中英提示；
- `ruler-2.js` 抽出 `applyLang()`，监听事件即时换四个 `title`，并保留中文默认值；
- `snip-2.js` 的 `EN` 改为 `let`，新增 `syncLang()`：更新提示文字，若工具条已建好则 `showBar()+syncBar()`；`tool/color/size` 都在闭包里，重建 DOM 不会丢状态。

**真机测试又抓到一个隐藏问题**：`TOOLS` 原来在脚本加载时就把 `label` 算成 `EN ? 'Rectangle' : '矩形'` 的固定字符串，所以 `syncLang` 重建后前五个工具名仍是英文。现把 `TOOLS` 改成 `[id, icon, 中文, English]` 四元组，`showBar` 每次按当前 `EN` 取 `label`。`test-aux-lang-live.js` 已覆盖 en→zh→en 往返。

### R27-2 上行测速响应没有上限

`NET.SPEEDTEST` 下行已经用 `readHttpCapped` 限制 64MB；上行分支仍是 `await r.arrayBuffer()`，会把测速端点返回的整个响应先读进主进程内存。测速地址可由用户填写，坏端点/误填大文件地址足以把唯一的主进程拖死。

修法：上行也改用 `readHttpCapped(r, HTTP_MAX_BYTES)`，并先检查 `r.ok`，失败给出明确响应码。

### R27-3 分片/合并/7z 长操作按钮可双击并发

`file-tools` 的分片、合并、7z 压缩、7z 解压按钮原来直接挂 `async` 处理器，双击会起两趟：

- 分片写同一组 `.partNNN`，两趟互相覆盖分片；
- 合并抢同一个 `finalOut`；
- 7z 的 `a` 对已存在归档是追加，两趟会把两批内容并进同一个包；
- 7z 解压争同一目标目录。

现统一用 `window.ui.guard(...)` 包住这五个按钮；任何 `return/throw` 都由 guard 复位，不会留下永久禁用的按钮。`test-round27-fixes.js` R27-06 锁住五个调用点。

### R27-4 局域网扫描旧进度污染新一趟

- 离开页面不会取消主进程 `LAN.SCAN`（阻塞式、无 job id），旧扫描会继续发 `job:progress`；回到页面重新扫描时，新监听只按 `kind === 'lan'` 过滤，旧事件的 `done/total` 会覆盖新进度条和状态文字。
- 渲染层每次扫描生成 `myToken = 'lan' + runToken`，随 `invoke` 传给主进程；主进程把 `token` 原样带进扫描/反查两个阶段的 `job:progress`；监听里 `if (d.token && d.token !== myToken) return`，老版本主进程不带 token 时仍兼容。

## 二、回归测试

新增 `scripts/test-round27-fixes.js`，7 条：

- R27-01 三个辅助窗广播后都派发 `hehe-lang`；
- R27-02 贴图提示即时中英切换；
- R27-03 标尺四个 title 即时中英切换；
- R27-04 截图工具条语言事件后重建，且保留工具/颜色/线宽状态；
- R27-05 上行测速响应必须流式截断并检查 `r.ok`；
- R27-06 分片/合并/7z 压缩解压按钮都有防重入 guard；
- R27-07 局域网扫描进度按本轮 token 过滤，旧一趟不能覆盖新一趟。

另新增 `scripts/test-aux-lang-live.js`：真实加载 `pin/ruler/snip` 三张页面，先英文、广播切中文、再切回英文，逐项读 `textContent/title/aria-label`。该用例真机 PASS；无桌面环境会 SKIP。

另跑既有测试：

- `node scripts/test-snip-e2e.js`：9 条全过（真实 Electron 截图标注）；
- `node scripts/test-snip-toolbar-ui.js`：13 条全过；
- `node scripts/test-aux-windows-csp.js`：18 条全过；
- `node scripts/test-net-tools.js`：1 条过。

## 三、门禁

- `npm run lint`：0
- `npm run typecheck`：0
- `scripts/test-round27-fixes.js`：6 通过 / 0 失败
- `scripts/test-aux-lang-live.js`：1 通过 / 0 失败（无桌面环境 SKIP）
- 全量 `test:count:write`：**224 脚本 / 2545 PASS**，基线已重拍；`--no-run` 核对无文件低于基线；7 个环境脚本跳过
- `test-source-assertions`：6 条通过（源码断言 1751、1287 条已写「锁的是」）
- `test-i18n-assertions`：226 条通过

## 四、仍未修 / 风险

1. **R24-45**：release 与内置 updater 两条更新路径口径分叉，统一需改更新协议，收益低于风险，未动。
2. **R24-51**：`jsconfig.json` 未覆盖 `main.js`、`preload.js` 与渲染层，需单独一轮类型清理。
3. **`HOSTS.BACKUP`**：已并入串行锁，但真实 hosts 写入需要管理员权限，未做本机实测。
4. **UI 固定宽度**：R25 已核对主要页面；560px 工具窗仍建议真实窗口截图复核。
5. **辅助窗语言事件**：本轮只覆盖语言文案；配色/明暗仍由原有 `aux:accent` 与广播路径负责。

## 五、范围声明

- 未做手工实机验收/交互；仅执行仓库既有自动化门禁（部分 UI 用例会拉起 Electron，属于测试本身）。
- 未提交、未 push；所有改动留在工作区待验收。
- 未触碰 `dist/` 与 `docs/copyright/`。
