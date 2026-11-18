# 第七轮代码审查记录（v0.9.0 · 深度核验）

> 日期：2026-11-17 · 范围：第六轮之后的**深层盲区**——子进程参数注入、PowerShell 脚本注入、
> TOCTOU 竞态、无界缓存/泄漏、IPC 参数混淆、破坏性操作的 fail-open 兜底
> 方式：只读审查 + 对抗性实测（PowerShell 等价替换验证，不执行真实电源/破坏命令）
> 排序：收益降序。实测脚本留 `.tmp-review7/`。
> 本轮**发现 1 个 fail-open 破坏性缺陷并修复 + 回归测试**；P0 门禁修复（第六轮）经深度 fuzz 确认无残留绕过。

---

## 一、本轮发现并修复

### 🟠 P1-1 `sys:restore-delete` 的 mode 兜底 fail-open 到「删全部」（已修复）
- **位置**：`main.js` `handle(CH.SYS.RESTORE_DELETE)`
- **现象**：原写法 `const flag = mode === 'oldest' ? '/oldest' : '/all'`。
  任何非 `'oldest'` 的值（拼错、`undefined`、未来新增入口传错）都会走 `/all`——
  **删光该卷全部卷影副本**（包括备份软件/文件历史创建的），不可恢复。
- **实测**（`.tmp-review7/verify-restore-mode.js`）：确认 `非 oldest 一律 /all`。
- **修复**：白名单化——`oldest`→`/oldest`、`all`→`/all`、其它值→抛错拒绝（fail-closed）。
- **回归**：`scripts/test-restore-point.js` 新增 RP8（禁止 fail-open + 白名单 + 非法值拒绝 + SA-4 合规）。
  `test-restore-point` 8/8，SA 6/6。

---

## 二、深度 fuzz：第六轮 P0 门禁修复无残留绕过

第六轮发现并修复了 `& (Get-Command Stop-Computer)` 门禁绕过（P0）。本轮用更全的等价族复验
（`.tmp-review7/deep-power.js`，用 `Write-Output` 替换危险词、看是否真输出 HEHE）：

```
执行但已拦  & (Get-Command Write-Output) HEHE
执行但已拦  & (Get-Command "Write-Output") HEHE
执行但已拦  & (Get-Command (Get-Command Write-Output)) HEHE   ← 嵌套
执行但已拦  $c = Get-Command Write-Output; & $c HEHE
执行但已拦  icm { Write-Output HEHE }                          ← Invoke-Command 别名
执行但已拦  . (Get-Command Write-Output) HEHE                   ← . 调用符
执行但已拦  powershell -Command "& { & (Get-Command Write-Output) HEHE }"  ← 多层包装
```
全部"执行但已拦"——没有真绕过残留。误报已剔除：`& (Get-Command W*) HEHE` 在 PowerShell 里
因返回多个命令而报错（不执行），不算绕过。

---

## 三、深度排除的疑似（实测确认安全）

| 疑似 | 实测 | 结论 |
|---|---|---|
| TTS 用户文本注入 PowerShell（`CH.TTS.SPEAK/WAV`） | `.tmp-review7/verify-tts-inject.js`：4 种 payload（闭合单引号、`$()`、反引号换行、`&` 调用）全部**原样输出**，不执行 | `ttsEsc` 单引号翻倍转义可靠，安全 |
| `es.exe` 查询参数注入（`CH.SEARCH.ES`） | `runCmd` 用 `execFile`，query 是独立 argv、不经过 shell | 无 OS 命令注入（Everything 查询语法另论） |
| `ps()` 模板插值注入 | 唯一两处为 `${parseInt(pid,10)}` 与数字 `n`（`Number.isInteger` 校验） | 安全 |
| handler 解构参数传 null（11 处无默认值） | `handle()` 统一 try/catch 把 TypeError 包装成 error 返回，不崩主进程 | 低危，不改 |
| 电源门禁其他形态 | 见上节深度 fuzz | 无残留绕过 |

---

## 四、逐域深度结论（未发现新问题）

| 域 | 深挖点 | 结论 |
|---|---|---|
| **子进程注入** | 全项目 spawn/execFile/runCmd 调用点 | 用户字符串进 argv 的都走 execFile（无 shell）；进 ps1 的都经 `psSingleQuote`/`ttsEsc`；进程 ID 都数值校验 |
| **hosts 写入** | TOCTOU：备份→写临时→rename→flushdns | 备份失败即中止；rename 失败有删旧+改名兜底；最坏有备份可恢复；无新竞态 |
| **进程白名单** | `killProcessChecked` 查询失败即拒绝、`n===process.pid` 拒绝、系统关键进程名拒绝 | 完整 |
| **schedules** | `normSchedule` 严格类型/范围校验，`everyMin` NaN 兜底；任务只发提醒不执行命令 | 完整 |
| **store 增长** | autostartBackup 按 name 去重；schedules 用户管理；无自动无限增长数组 | 完整 |
| **zip 回滚** | 第六轮记录的"残留空目录"P2 仍在（本轮确认影响低，未修） | 记录 |

---

## 五、交付说明

- 本轮**修复 1 个 fail-open 破坏性缺陷**：`sys:restore-delete` 的 mode 白名单。
  改动：`main.js`（判据）、`scripts/test-restore-point.js`（RP8）。
- 加上第六轮未提交的 P0 门禁修复，当前工作区共 **6 项未提交改动**：
  `lib/power-gate.js`、`scripts/test-powergate.js`、`main.js`、`scripts/test-restore-point.js`、
  `scripts/assertions-baseline.json`、`docs/review-round6.md`、本文件 `docs/review-round7.md`。
- 全量测试（含两轮修复）：**205 脚本 / 2289 PASS / 0 失败**；lint/typecheck 0。
  断言基线待两轮都定稿后统一 `test:count:write` 更新。
- 实测脚本/截图在 `.tmp-review7/`（临时目录，提交前可删）。
- 两轮修复均**未提交、未发版**。
