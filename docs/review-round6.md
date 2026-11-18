# 第六轮代码审查记录（v0.9.0 · 已发布版）

> 日期：2026-11-17 · 范围：v0.9.0 未深挖的域（path-guard / 更新流程 / 电源门禁 / 媒体下载 / 渲染层 / 视觉）
> 方式：只读审查 + 对抗性实测（不执行真实电源命令、不改用户环境）+ CDP 多工具页截图
> 排序：按收益从高到低（收益 ≈ 严重度 × 触发概率 × 影响面）
> 实测脚本与截图：`.tmp-review6/`（verify-*.js / power-fuzz.js / visual.js / shots/）
> 本轮**发现 1 个 P0 并已修复 + 回归测试**；其余为 P2/记录项。

---

## 一、已确认缺陷（按收益降序）

### 🔴 P0-1 电源门禁可被 `Get-Command` 间接调用绕过（已修复）
- **位置**：`lib/power-gate.js` `textHasDanger()`（修复前）
- **现象**：`& (Get-Command Stop-Computer)`、`powershell -c "& (Get-Command Stop-Computer)"`、`& (gcm Stop-Computer)` 这类写法在 PowerShell 里**真的会执行关机**，但门禁放行。
- **根因**：`extractParens` 递归进括号组后首词是 `get-command`（不在 DANGER_TOKENS），`Stop-Computer` 只是它的参数，未被执行头识别。
- **实测证据**（`.tmp-review6/verify-getcommand.js`，用 `Write-Output` 做等价替换，绝不真关机）：
  ```
  ★执行 "& (Get-Command Write-Output) HEHE" → 输出 HEHE
  ★执行 "$c = Get-Command Write-Output; & $c HEHE" → 输出 HEHE
  ★执行 "Invoke-Command { Write-Output HEHE }" → 输出 HEHE
  ```
  修复前 `isPowerCommand('& (Get-Command Stop-Computer)') === false`。
- **修复**：在 `textHasDanger` 段内加判据——`get-command`/`gcm` + 调用运算符（`&`/`.`）+ 危险词根三者同时出现即拦。纯查询（无调用运算符）仍放行，实测无误伤：
  ```
  拦截 & (Get-Command Stop-Computer) / & (gcm Stop-Computer) / powershell -c "& (Get-Command Stop-Computer)"
  放行 Get-Command Stop-Computer / echo Get-Command Stop-Computer / & (Get-Command notepad)
  ```
- **回归测试**：`scripts/test-powergate.js` 新增 t27（5 条必拦 + 5 条必放行 + 源码断言）。`test-powergate` 75/75 全过，lint/typecheck 0。
- **判定**：这是**唯一一个真实可利用的缺陷**。其余 fuzz 候选中，`cmd /c "sh"utdown /s`、`shut""down`、`Stop-Comp`（缩写）、`schtasks /create` 经实测**均不会执行危险动作**（属误报，已剔除）。

### 🟡 P2-2 ZIP 解压失败回滚残留空目录 —— **已修复（第 11 批）**
- **修复**：`lib/path-guard.js` 新增 `ensureDirectoryInsideTracked(root, rel, createdOut)`
  ——与 `ensureDirectoryInside` 同一套安全语义（resolveInside 前置、lstat 拒链接、
  realpath 越界复核），但把「本次新建」的目录记录进 `createdOut`
  （判据是 mkdir 是否抛 EEXIST：抛了=用户已有，不能删；成功=本次新建，可回滚）。
  `ipc/fs-ops.js` 的 `zip:extract` 回滚改为：文件删除后**由深到浅 rmdir** 新建目录
  （非空 ENOTEMPTY 就留着——里面可能有并发写入，误删比残留危险）。
- **回归**：`test-path-guard` 25d（已有目录不记/新建全记/逆序 rmdir 清干净/已有目录保留）
  + `test-file-safety` 解压写满用例改为嵌套目录包并断言 `sub/` 被清掉、用户文件保留。
- **验证**：path-guard 40/40、file-safety 12/12。

---

## 二、排除的疑似问题（实测确认非缺陷，避免误改）

| 疑似 | 验证 | 结论 |
|---|---|---|
| `Set-ItemProperty -Type ExpandString` 对已存在值无效（会让 v0.9.0 的 P1-3 修复失效） | `.tmp-review6/verify-regtype.js`：先建 REG_SZ 再用 `-Type ExpandString` 写 → 实际变 ExpandString；反向 ExpandString→String 也生效 | ✅ 修复有效，无需改 |
| env-manager 英文文案插值 `{path}` 走 innerHTML 造成 XSS | `.tmp-review6/verify-i18n-xss.js`：同时含 `T()` 与 `innerHTML` 的行 0 条，所有文案经 `div()`→textNode | ✅ 无 XSS 面 |
| `spawn('cmd.exe')` 被 PATH 同名文件劫持 | Node 只按精确文件名 + PATHEXT 查找，前置目录需可写同名真 PE（已属特权） | ✅ 低危，不改 |
| `cmd /c "sh"utdown /s` / `shut""down` 引号拼接绕过门禁 | 用 `"ec"ho` 等价验证：系统找不到命令，**不能执行** | ✅ 误报 |
| `powershell -c Stop-Comp` / `Stop-Comp*` 命令缩写绕过 | 实测 CommandNotFoundException，PowerShell 不支持 Linux 式缩写 | ✅ 误报 |
| `schtasks /create /tr "shutdown /s"` 立即关机 | 实测仅创建任务（指定 23:59），/create 本身不执行 | ✅ 误报（若配置立即触发的任务另说，但那需管理员且非本工具路径） |

---

## 三、逐域审查结论（未发现新问题）

| 域 | 结论 |
|---|---|
| **path-guard** | 动态系统目录、尾点/空格归一、`\\?\` 前缀剥离、盘符相对拒绝、非递归删系统文件、类型闸门——多轮加固齐全，未见新绕过面 |
| **更新流程** | target 只认 `PORTABLE_EXECUTABLE_FILE`/`app.getPath('exe')`，不接受渲染层 target；newExe 目录+体积+SHA+PE 头校验；脚本 BOM、多份备份、回滚脚本、spawnDetached——完整 |
| **媒体/录制** | recDeath 异常退出降级、分段合并失败保留、GIF 目标名不误删、进程树 kill、ffmpeg 编码探测缓存、jobs 归属取消——完整 |
| **下载器** | 断点续传校验 ETag/If-Range、representation 一致性、6 次重试、取消清理、owned 标志——完整 |
| **渲染层** | 拖拽绑定幂等、JobPrefix 单 id 认领、整壳重建后清理句柄、window closed 取消归属任务、windowSecurity 拒绝外部跳转——完整 |
| **i18n** | env 域 12 工具已迁，漏翻回退中文、无孤儿条目，插值经 textNode——完整 |

---

## 四、视觉走查（CDP 实测，无缺陷）

> 截图：`.tmp-review6/shots/`（`zh-{disk-analyze,junk-clean,restore-points,autostart,tool-chain,env-manager}.png`、
> `en-{env-manager,tool-chain}.png`、`en-dark-env-manager.png`）

| 检查项 | 结果 |
|---|---|
| 6 个工具页横向溢出 | ✅ 全部 `scrollWidth=729 < winWidth=1001`，overflow 数组空 |
| 明暗主题 | ✅ 亮/暗对比度正常，高危卡（垃圾清理未启用）红卡提示清晰，部分锁卡（还原点）橙色提示正确 |
| 英文态 | ✅ env-manager 正文全英文（v0.9.0 已迁），面包屑/模块标签栏同步英文 |
| 拖拽区/卡片 | ✅ 工具链空态、待处理文件拖拽区、系统还原点操作按钮布局正常 |
| 状态栏 | ✅ CPU/内存读数正常，无遮挡 |

**视觉结论：未发现布局、对比度、溢出或文案渲染缺陷。**

---

## 五、修复优先级与建议

| 优先级 | 项 | 状态 |
|---|---|---|
| — | P0-1 Get-Command 门禁绕过 | ✅ 本轮已修 + 回归测试 75/75 |
| 低 | P2-2 ZIP 回滚残留空目录 | 记录，建议下轮带 createdDirs 栈修复 |
| — | 其余疑似 | 实测剔除，不改 |

---

## 六、交付说明

- 本轮**发现并修复 1 个真实 P0 门禁绕过**：`& (Get-Command Stop-Computer)` 族。修改文件：`lib/power-gate.js`（判据）+ `scripts/test-powergate.js`（t27）。
- ⚠️ 该修复**尚未提交、未发版**：当前工作区有这 2 个文件的未提交改动。需要走正常的 commit → push → CI → tag → Release 流程（下一版 v0.9.1 或并入后续版本）。
- 审查记录本文件 `docs/review-round6.md` 亦为新增未提交文件。
- 实测脚本/截图留在 `.tmp-review6/`（临时目录，提交前可删）。
