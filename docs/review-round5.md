# 第五轮代码审查记录（v0.8.9 · 开发环境）

> 日期：2026-11-15 · 范围：v0.8.9 新增「开发环境」全链路 + v0.8.8 子系统复查 + 视觉走查
> 方式：只读审查 + 可复现实测（不修改产品代码、不写用户环境）+ CDP 截图
> 排序：按**收益从高到低**（收益 ≈ 严重度 × 触发概率 × 影响面）
> 实测脚本与截图留存于 `.tmp-review/`（verify-*.js / visual*.js / shots/）

---

## 一、实测确认的缺陷（有复现证据）

### 🔴 P0-1 中文 PATH 读回乱码 → 写回会损坏用户 PATH
- **位置**：`ipc/env-manager.js:117-118` `readUserEnv()`
- **现象**：用 `runCmd('powershell.exe', …, '-Command', script)` 读用户 PATH，**没有**像 `main.js:470 ps()` 那样加 `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;` 前缀。PowerShell 5.1 默认按 OEM 代码页（中文系统 GBK）输出，`runCmd` 却按 utf8 解码 → 含中文的 PATH 读回即乱码。
- **实测**（`.tmp-review/verify-encoding2.js`）：
  ```
  原始样本    : C:\开发工具\node;C:\Program Files\测试目录;D:\环境\bin
  无前缀读回  : C:\????\node;…（乱码）  一致: false
  带前缀读回  : C:\开发工具\node;…        一致: true
  ```
- **后果**：`applyIds`/`unapplyIds` 都是「读 → 改 → 写回」。一旦用户 PATH 含中文（中文用户名、`C:\程序\…`、国产软件目录极常见），**任何一次「加入环境/撤销」都会把整段用户 PATH 写成乱码**，且不可逆（备份只存 JAVA_HOME，不存 PATH）。这是数据损坏级缺陷。
- **为何漏网**：本机当前 PATH 恰好全 ASCII，E2E 没触发；状态机测试用注入的 `userEnvIO`，绕过了真实 PowerShell 编码路径。
- **解法**：`readUserEnv` 的脚本前加 `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; `（与 `ps()` 一致）。**更稳妥**：直接复用 `ps()`（注入或改调），不要自己拼 powershell 命令。补一条「含中文 PATH 读回往返一致」的行为测试（用真实 powershell，标 `HEHE_TEST_PS=1` 才跑）。
- **收益**：极高。阻止最常见的数据损坏路径。

### 🟠 P1-2 moveFile 对目录跨卷（EXDEV）必失败 → 安装落盘可能中断
- **位置**：`main.js:522-541 moveFile()`；调用方 `ipc/env-manager.js:344/346/348`
- **现象**：EXDEV 回退分支用 `fsp.copyFile(src,dst)`，**copyFile 不支持目录**。env 安装把「解压出的目录」`moveFile(root, layout.dir)`，源（staging）与目标（envs）虽同在 userData，但 `HEHE_TEST_DATA`/符号链接/挂载点可致跨卷。
- **实测**（`.tmp-review/verify-movefile.js`）：`copyFile 对目录 → EPERM`。
- **后果**：跨卷时安装抛 EPERM；回滚 `moveFile(trash, layout.dir)` 同样失败 → 旧版本留在 `.old-*`、新版本没就位，用户看到「安装失败」且目录处于半残状态。
- **解法**：`moveFile` 的 EXDEV 分支按 `stat.isDirectory()` 分流——目录用递归复制（`fsp.cp(src,dst,{recursive:true})`，Node 24 支持）+ 校验 + 删源；文件维持 copyFile。或 env 安装改用「同卷 staging」（staging 已建在 ENV_ROOT 下，正常同卷，此 bug 仅在异常拓扑触发，故定 P1）。补目录跨卷测试。
- **收益**：高。消除一类安装失败 + 半残目录。

### 🟠 P1-3 .NET SetEnvironmentVariable 恒写 REG_SZ → 含 %VAR% 的 PATH 被降级
- **位置**：`ipc/env-manager.js:134/137 writeUserEnv()`
- **现象**：`[Environment]::SetEnvironmentVariable(…, 'User')` 总是写 **REG_SZ**。若用户 PATH 原本是 **REG_EXPAND_SZ** 且含 `%VAR%`（如 `%USERPROFILE%\bin`），写回后类型变 REG_SZ，`%VAR%` 不再展开 → 相关路径失效。
- **实测**（`.tmp-review/verify-regtype.js`）：`.NET 写入含 %TEMP% 的值 → 类型: String`（确认恒写 REG_SZ）。本机当前 PATH 是 String 且无 %VAR%，故未触发，属**条件触发**。
- **后果**：对「PATH 里有环境变量引用」的用户，加入/撤销环境会静默废掉那些引用路径。
- **解法**：写 PATH 时保留原值类型——先 `GetValueKind('Path')`，若为 ExpandString 则用 `Set-ItemProperty -Type ExpandString` 写（而非 .NET API）；或统一用 `reg add HKCU\Environment /v Path /t REG_EXPAND_SZ`（按原类型）。读侧也要用 `DoNotExpandEnvironmentNames` 取**未展开**原值，避免把 `%VAR%` 读成展开后的字面量再写回。补「ExpandString 往返保类型」测试。
- **收益**：高（影响面取决于用户 PATH 形态，但一旦触发是静默损坏）。

---

## 二、高收益健壮性 / 正确性问题（代码确证，未逐一实测）

### 🟠 P1-4 下载缓存「非空即跳过下载」→ 截断包反复校验失败、无法自愈
- **位置**：`ipc/env-manager.js:328`
- **现象**：`if (!(await exists(archive)) || size===0) download()`。只要缓存文件**非空**就跳过下载，直接 SHA 校验。若上次下载被中断留下**截断但非空**的包（`downloadToFile` 的 `.part` rename 时机/杀软干预可致），则每次安装都「校验失败 → 删包 → 重试」，但重试又因……实际删包后下次会重下，可自愈；**真正的问题**是校验失败删包后，若用户立刻再点，`exists` 已 false 会重下——尚可。但若包**完整但 SHA 不符**（镜像被篡改/版本漂移），删包重下仍是同一个错包 → 死循环式失败，且无「换源/报错版本」提示。
- **解法**：校验失败时区分「网络截断」与「内容不符」；对后者给出明确错误（含期望/实际 SHA 前 8 位）并建议检查镜像，不要无限重下。缓存命中先比对 size 与清单（清单可加 `size` 字段）。
- **收益**：中高。避免一类「永远装不上」的困惑。

### 🟠 P1-5 安装/应用/撤销无并发互斥 → 竞态可写坏 PATH 或 manifest
- **位置**：`ipc/env-manager.js` INSTALL/APPLY/UNAPPLY/REMOVE 各 handler
- **现象**：UI 的 `busy` 只挡「安装」按钮，**不挡**「加入环境/从环境移除/撤销全部/删除」。这些 handler 各自 `readUserEnv → 改 → writeUserEnv`，无锁。两个操作交错（如「加入 node」与「撤销全部」同时）会基于同一份旧 PATH 各写一次 → 后写覆盖先写，丢失更新；manifest 的 `manifestGet→改→manifestSet` 同样非原子。
- **解法**：给「用户环境写」加一把进程内串行锁（Promise 链/async-mutex），所有 apply/unapply/install 的环境写段排队执行；manifest 读写 likewise。UI 侧 busy 期间禁用全部环境操作按钮。
- **收益**：中高。消除竞态导致的 PATH 丢失更新。

### 🟡 P2-6 撤销全部后残留 `.old-*` / `.staging-*` / downloads 无清理
- **位置**：`ipc/env-manager.js:343/337/325`
- **现象**：升级留 `layout.dir + '.old-' + ts`，正常路径会删（351），但**失败/取消**时 `.old-*`、`.staging-*` 残留；`downloads/` 的安装包永久保留（Node 30MB/JDK 190MB/MinGW 110MB/Python 30MB）。无「清理缓存」入口，也不在 junk-clean 扫描范围。
- **解法**：启动时清扫 `envs/.staging-*` 与超龄 `.old-*`；downloads 提供「清理安装包」按钮或纳入 junk-clean 候选；安装成功后可选删包。
- **收益**：中。磁盘占用 + 半残目录可见性。

### 🟡 P2-7 detectAll 串行 + 无缓存，每次进页面/刷新都跑 ~10 个子进程
- **位置**：`ipc/env-manager.js:259-287`
- **现象**：`where python/py -0p/python --version/where node/node -v/where java/java -version/where gcc(/g++)/gcc --version` 全串行，每个 5–8s 超时上限；`loadCatalog` 每次都 `loadDetect`。冷启动慢（实测页面 detect 约 1–3s，最坏可达数十秒）。
- **解法**：四组探测 `Promise.all` 并行；结果缓存 30–60s（刷新按钮强制重探）；`where` 失败快速短路。
- **收益**：中。首屏与刷新体验。

### 🟡 P2-8 「打开带环境的终端」用 cmd /k + 中文 echo，编码与注入面
- **位置**：`ipc/env-manager.js:396-397`
- **现象**：`spawn('cmd.exe', ['/k', 'echo 已加载…' + label + ' & echo …'])`。label 来自 manifest 版本号（受控），但 `&` 拼接 + 中文在 GBK 控制台可能乱码；若未来 label 含特殊字符有命令注入面。`stdio:'ignore'` + detached 在部分环境窗口不弹出。
- **解法**：改用 `cmd /k` 后跟一个**生成的 .cmd 脚本**（设 PATH/JAVA_HOME + chcp 65001 + echo），避免命令行拼接；或 spawn 时 `env` 已注入、直接 `cmd /k` 不带 echo。版本号入 manifest 前校验形态。
- **收益**：中。可靠性 + 消除潜在注入面。

### 🟡 P2-9 env-manager 未登记高危能力，与「改用户环境」的风险叙述不一致
- **位置**：`main.js:729 TOOL_DANGEROUS_CAPS`（无 env-manager）；`ipc/env-manager.js:9-10` 注释明确「不加新高危能力」
- **现象**：这是**用户明确决策**（默认加入用户环境 + 可撤销 + 只 HKCU），代码与决策一致，**非 bug**。但「修改用户 PATH」客观上影响全账户，项目其它写注册表操作（autostart/ctxmenu）都走 registry-edit 门禁。此处不一致是**有意为之**，记录在案以免后续审查误判或误加门禁破坏默认行为。
- **解法**：维持现状；若将来要加门禁，须同步把默认改为「仅本工具」，否则默认行为被门禁挡死。建议在设置页高危区补一句说明「开发环境改用户 PATH 不走门禁，因可撤销且仅当前账户」。
- **收益**：低（一致性/可维护性，非功能缺陷）。

---

## 三、视觉 / UX 走查结果（CDP 实测）

> 截图：`.tmp-review/shots/01-light-zh / 02-dark-zh / 04-en-top / 06-cards-zh / 07-narrow-zh`

| 检查项 | 结果 |
|---|---|
| 明色 / 暗色对比度 | ✅ 正常，警告卡橙色边框、tag 配色在两态均可读 |
| 英文态 | ✅ 外壳英文 + 顶部「正文暂仅支持中文」提示正确出现（env-manager 未接 TT，符合现状） |
| 横向溢出 | ✅ `pageScrollW=729 < winW=1001`，无元素超出视口 |
| 窄窗（860px） | ✅ 按钮行 rowH=26 不换行不挤压，最右按钮 right=812 < 860 |
| 空按钮 / 缺图标 | ✅ 无空按钮；box/alert/stop/download/trash/zap/unlock/external/terminal/refresh 图标均存在 |
| 卡片布局 | ✅ 四张运行时卡 + 检测卡 + 警告卡层次清晰 |

**视觉结论：未发现布局/对比度/溢出缺陷。** 唯一 UX 观察（非缺陷）：
- 🟡 **UX-1** 英文态正文整片中文（已有顶部提示兜底）。若要改善，按 `js/tools/i18n.js` 机制给 env-manager 加 `env` 域 + `i18n:true`。收益低（项目既定边界）。
- 🟡 **UX-2** 「检测到已有版本」警告里用 `d.id`（python/node）而非友好名（Python/Node.js），与卡片标题不一致。建议改用 `rt.name`。收益低。

---

## 四、v0.8.8 子系统复查（pass D）

| 模块 | 结论 |
|---|---|
| chain.js hash extras | ✅ 对齐正确：`inputs=alive.map(cur)`、`extras[i]↔alive[i]`，失败留空串不错位；`res.extras.length===inputs.length` 守卫到位 |
| chain 报告渲染 | ✅ `for (const line of s.extras)` 逐条渲染，mono 小字 |
| env-catalog 自检 | ✅ validateCatalog 覆盖 https/sha64/格式/binDirs 穿越；EC1–EC6 全过 |
| env-path 纯函数 | ✅ 不重排不去重用户项、保尾分号、精确整项移除；EP1–EP5 全过 |
| env-detect 解析 | ✅ py 双写法/java stderr/node v 前缀/gcc 版本；ED1–ED5 全过 |
| 状态机 | ✅ ES1–ES8 全过（含尾分号逐字还原） |

> 注：状态机测试用注入 userEnvIO，**未覆盖真实 PowerShell 编码/注册表类型路径**——这正是 P0-1/P1-3 漏网的原因。建议补真实 powershell 的往返测试。

---

## 五、横切扫描（pass E）小结

- **错误吞没**：`safeCmd` 把子进程失败转 `{code:-1}` 静默——探测场景可接受（找不到=未安装），但 `readUserEnv` 的失败必须抛（已抛，✅）。
- **临时脚本清理**：`writeUserEnv` 的 `.ps1` 在 finally 删除（✅）；但进程被强杀时残留，建议启动清扫 `envs/.env-write-*.ps1`。
- **注入面**：`psSingleQuote` 单引号翻倍转义正确（✅）；PATH 值经它包裹，无命令注入。cmd /k 拼接见 P2-8。
- **资源泄漏**：sha256File 的 readStream 在 error 时未显式 destroy（Node 会自动收，低风险）；download 的 reader/file 在 finally 关闭（✅）。
- **i18n**：env-manager 未接 TT，英文态有兜底提示（符合现状，见 UX-1）。

---

## 六、修复优先级建议（按收益降序）

1. **P0-1** readUserEnv 加 UTF-8 前缀（或复用 ps()）+ 中文往返测试 —— 阻止数据损坏，**最高优先**
2. **P1-3** 写 PATH 保留注册表值类型 + 读未展开原值 —— 阻止 %VAR% 静默失效
3. **P1-2** moveFile 目录跨卷用递归复制 —— 消除安装半残
4. **P1-5** 用户环境写加串行锁 + UI busy 全按钮禁用 —— 消除竞态
5. **P1-4** 校验失败区分截断/内容不符 + 缓存 size 比对 —— 消除「永远装不上」
6. **P2-7** detect 并行 + 缓存 —— 首屏提速
7. **P2-6** 残留目录/安装包清理 —— 磁盘与整洁
8. **P2-8** 终端改 .cmd 脚本 —— 可靠性
9. **UX-2 / P2-9 / UX-1** 文案与一致性 —— 低优先

> 本轮为**只读审查**，未改动任何产品代码。以上 1–5 建议下一轮修复并补真实 PowerShell 往返测试；6–9 视排期。

---

## 七、修复情况（2026-11-15，第二轮：全部修复）

| 编号 | 状态 | 改动 | 验证 |
|---|---|---|---|
| **P0-1** | ✅ 已修 | `readUserEnv` 脚本加强制 UTF-8 输出；同时改为 `DoNotExpandEnvironmentNames` 读未展开原值 | `test-env-userenv-read`（`HEHE_TEST_PS=1` 真实注册表对照）+ 真机 E2E |
| **P1-2** | ✅ 已修 | `moveFile` 的 EXDEV 分支按 `isDirectory()` 分流：目录用 `fsp.cp(recursive)` + 目标校验 | 实测脚本复现旧行为 EPERM；源码断言 EM10 |
| **P1-3** | ✅ 已修 | 写 PATH/JAVA_HOME 改为按 `GetValueKind` 用 `Set-ItemProperty -Type` 写回，不再用会降级 REG_SZ 的 .NET API | 状态机 ES9（ExpandString + %VAR% 往返）+ 断言 EM12 |
| **P1-4** | ✅ 已修 | 缓存先校验 SHA；不符则删包重下；再次不符报「期望/实际前 8 位」明确错误 | 断言 EM14 |
| **P1-5** | ✅ 已修 | `withEnvLock` 串行锁包住 apply/unapply/manifest；`installing` 禁止同一运行时并行安装；UI `setBusy` 禁用全部操作按钮 | 状态机 ES10（并发不丢更新）+ 断言 EM13 |
| **P2-6** | ✅ 已修 | 启动清扫 `.staging-*` / `.old-*` / `.env-write-*` / `.term-*`（10 分钟以上）；新增 `env:clean` 清理安装包 + 界面按钮 | 断言 EM16；通道 195 → **196** |
| **P2-7** | ✅ 已修 | 四组探测 `Promise.all` 并行；DETECT 60 秒缓存（安装/加环境后 force 重探）；跳过 `WindowsApps` 的 python 别名 | 断言 EM15 |
| **P2-8** | ✅ 已修 | 「打开带环境的终端」改为写临时 `.cmd`（chcp + ASCII 提示），不再拼 cmd 命令行 | 断言 EM16 |
| **UX-2** | ✅ 已修 | 警告与「本机已装」改用运行时名称（Python/Node.js…）而非 id | 人工 + 截图 |
| **UX-1** | ✅ 已修 | env-manager 接入工具页 i18n（`env` 域、`i18n: true`），英文态正文完整翻译；README 口径更新为 12 个已迁 / 99 个未迁 | `test-tool-i18n` 8/8 |
| **P2-9** | — 维持 | 「改用户 PATH 不走高危门禁」是用户明确的产品决策（默认加入 + 可撤销 + 仅 HKCU），非缺陷；记录在案 | — |

新增/更新测试：
- `scripts/test-env-userenv-read.js`：opt-in 真实注册表**只读**对照（默认 SKIP，`HEHE_TEST_PS=1` 运行）。
- `test-env-manager-state` 扩到 11 条（类型保留、并发、旧备份兼容）。
- `test-env-manager-impl` 扩到 16 条（编码、类型、锁、缓存、并行、清扫、终端脚本）。
- 真机 E2E：安装 Node → 加环境（PATH 类型仍 String）→ `node -v` → 撤销逐字还原 → 删除干净，全绿。