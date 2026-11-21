# 第十二轮代码审查记录（v0.9.2 · dev/office 逐行 + lib 补漏 + main.js 区段）

> 日期：2026-11-20 · 方式：逐行核验 + 真实实现抽取跑边界（`.tmp-r13/`），不跑实机、不派子代理
> 本轮修复 **4 项缺陷**（防重入 7 处算 1 组），另排除 3 处探测脚本自身的错误断言。

## 一、确认修复（收益降序）

### 🟠 R12-1 HTTP 客户端 send 无防重入（已修）
- **位置**：`js/tools/dev.js` http-client
- **现象**：HTTP 请求动辄几秒，连点「发送」会并发多个请求；后完成的覆盖先完成的
  —— 响应区显示的可能第一次请求的 body，状态行却写着第二次的状态，请求与响应对不上。
- **依据**：同文件其余工具与全项目约定统一走 `ui.guard()`（ui.js 注释明说这类 bug 历史上出现 7 次）。
- **修复**：`const send = window.ui.guard(async () => {...})`。
- **回归**：`test-round12-fixes.js` R1（源码断言：接线事实）。

### 🟠 R12-2 office.js 七处长任务无防重入（已修）
- **位置**：`js/tools/office.js`
- **现象**：PDF 合并/提取/拆分/旋转、图片转 PDF、文档预览（LibreOffice 转换）、翻译
  —— 全部没有防重入。而**同文件**的 `pdf2img` 与 `pdf-office-convert` 都有 `running` 标志，
  证明是漏写不是设计。连点后果：并发跑两份 pdf-lib、对同一输出路径弹两次保存框、
  并发拉起两个 soffice 进程、8 秒超时窗内翻译返回顺序不定。
- **修复**：7 处全部接 `window.ui.guard()`。
- **回归**：R2（7 条正则断言）。

### 🟡 R12-3 cqFor 无效输入回退值与界面默认不符（已修）
- **位置**：`lib/hw-encode.js`
- **现象**：`cqFor(NaN)` 返回 `CQ_MIN + CQ_OFFSET`（18+7=**25**），注释却写"按默认 crf23 处理"
  ——而界面默认 crf 是 **23**（`av-convert` 输入框 `value:'23'`、media-ffmpeg 回退 `opts.crf || 23`）。
  crf23 应得 cq**30**。cq25 的体积比 cq30 大约 40%（模块头部实测表）。
  实际触发面窄（调用方总是传数字），但注释承诺与实现不符就是缺陷。
- **修复**：新增 `CQ_FALLBACK_CRF = 23`（注释写明为什么必须对齐界面默认），无效输入回退 `min(CQ_MAX, 23+7)=30`。
- **回归**：R3（行为断言：NaN/undefined/'abc' → 30；clamp 行为不变）。

### 🟡 R12-4 局域网扫描列表可能没有本机（已修）
- **位置**：`lib/lan-scan.js` `mergeDevices` + `js/tools/lan-scan.js` 渲染层
- **现象**：`selfIp` 早已传进 `mergeDevices`，但只在 ARP/ping 恰好命中时才自然出现。
  边界真实存在：Windows 防火墙「公用网络」配置文件默认拦入站 ICMP，**本机 ping 自己也可能不通**，
  此时设备列表没有本机行 —— 用户无法分辨"列表里哪个是我"。
- **修复**：`mergeDevices` 无条件补本机条目（`source:'self'`；已命中则合并、置 `isSelf`）；
  渲染层补 `'self': '本机'` 标签映射（tag-blue）。
- **回归**：R4（未命中补行 / 已命中合并不重复）+ R5。

## 二、探测脚本自身错误（代码正确，已修正脚本）

这一轮又是三次「先怀疑自己」：

1. **对比度判据遗留**：连续第二轮差点被「白字 vs 主色」假设误导，本轮直接跳过（上一轮已验证用 `--on-primary`）。
2. **hw 探测断言写错**：`listCandidates` 的 `\b` 对 `h264_qsv_foo` 的拦截**实测正确**（返回 3 个候选），
   我的断言失败是因为文件里残留旧断言版本。重写干净后 4 组全过。
3. **mergeDevices 调用方式错**：我按 `mergeDevices(arp, pinged)` 传参，实际签名是 `mergeDevices({arp, pinged, selfIp, names})`。
   修正调用后暴露出 R12-4 这个真缺陷——探测方式错了也能间接找到真问题。

## 三、核查通过（无缺陷）

| 面 | 结论 |
|---|---|
| dev.js 纯逻辑 | LCS diff（CAP=4000 对 Uint16Array 安全，dp 峰值 4000 ≪ 65535）、颜色四向换算边界（纯黑/纯白/灰色）、UUID v4 格式、手机号 11 位（10 万次实测）、随机字符串分块填充——全部正确 |
| dev.js 取色器 | `calcPickPoint` 越界夹取、pickCleanup 槽位防泄漏（第四轮修的）依然完好 |
| dev.js 静态服务器 | 进页先查 SERVER.STATUS 回填状态（死局已修）仍在 |
| office.js parseRanges | 反向区间拒绝、去重保序、越界报页数——正确 |
| target-size.js | 解锁收口 `unlockUi()`（早退与 finally 都调）、runJobId 认领时序、10^6 MB 口径注释——完整 |
| life.js | 番茄钟通知收口 `notify()`、秒表暂停续计、日历 drawSeq/infoSeq 竞态守卫、notes 删除防重复点击——完整 |
| lib/dir-move.js | 17/17 拒绝矩阵（UNC 原始串判据、残留备份前置、dstProtected 默认自算、freeBytes 三态）、rollbackPlan 全步覆盖——完备 |
| lib/drop-route.js | **175 个工具·扩展对全部真实存在**（与 tools/*.js 的 register id 对账）、主要扩展名全覆盖、默认候选有效 |
| lib/lan-scan.js | /24 展开 254、私有网段判定（172.16-31 正确）、mergeDevices 过滤广播与 .0 |
| main.js 托盘/热键 | applyHotkey 新键失败保留旧键、TRAY_I18N zh/en 键完全对称 + trayText 有 zh 回退、CPU 采样夹取 |
| main.js 窗口加固 | hardenWindow 五件套（deny window.open / will-navigate / frame-navigate / 权限白名单 / check 一致）仍在 |
| CSS 一致性 | 253 处 card-title 全部走类名零内联覆盖；191 个"工具零引用"的类经查全部被 app.js 外壳使用，无死代码 |

## 四、验证

- 全量 **206 脚本 / 2278 PASS / 0 失败 / 4 环境跳过**（新增 `test-round12-fixes.js` 5 条；
  `test-lan-scan.js` 的 4 个合并用例按 R12-4 新契约更新——本机行计入或排除后断言其余设备；
  另给 lan-scan 的既有裸源码断言补齐「锁的是」注释，SA 守卫 6/6）
- lint 0 / typecheck 0
- 断言基线重拍：**2278**
- 【偶发记录】`test-download-entity.js` 在一次全量中因 `fetch failed` 失败（30.3s 超时），
  串行复跑 6 次 + 两次全量（2277/2278 PASS）均绿——本机 localhost 回环在高负载时偶发拒绝，
  非代码缺陷，不做改动。

## 五、状态

改动文件：`js/tools/dev.js`、`js/tools/office.js`、`js/tools/lan-scan.js`、
`lib/hw-encode.js`、`lib/lan-scan.js`、`scripts/test-round12-fixes.js`（新增）、
`scripts/test-lan-scan.js`（按新契约更新 + SA 注释补齐）、`scripts/assertions-baseline.json`。

**未提交**。工作区同时包含上一会话遗留的合理未提交改动（一并纳入）：
- `lib/safe-name.js`：fromUrl/fromTitle 的「负数 slice」修复（扩展名超预算时不再反向变长）
- `js/tools/env-manager.js` + `js/tools/i18n.js`：环境检测失败不再伪装成「没有已装环境」（与 R11-2 同类空 catch）
- `eslint.config.js`：`promo/scripts/` 纳入 node 环境（lint 门禁 13 条 no-undef）
- `promo/README.md`、`promo/.gitignore`：混音脚本入库（`promo/scripts/mix-audio.js`）+ ffmpeg 忽略
- `promo/src/Main.tsx`：开场注释与实现同步

**审查结论**：本轮 4 项修复 + 核查 11 个面无缺陷。经 12 轮审查，核心域
（主进程 IPC、path-guard、archive-guard、power-gate、ui.js、file-tools、office、
dev、life、target-size、lan-scan、dir-move、drop-route、hw-encode、mojibake、
prefs-spec、temp-names、safe-name、CSS 主题、i18n、异步竞态、布局一致性）
已全部深审过；新增发现的缺陷密度已降到每轮 4 项以下且全部为 P2 级，
边际收益明显下降，建议转入「按需审查」（新功能提交时审）而非整轮轮询。