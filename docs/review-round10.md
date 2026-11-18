# 第十轮代码审查记录（v0.9.0 · file-tools 全量 + fs-ops 密码学边界 + 临时名体系）

> 日期：2026-11-17 · 方式：逐行核验 + 对抗性复刻验证（`.tmp-r10/`），不跑实机
> 本轮**发现并修复 1 个真实缺陷**（临时名脱离白名单体系），其余为误报剔除与确认。

## 一、发现并修复

### 🟠 P1 批量重命名的暂存名脱离临时名白名单（已修复）
- **位置**：`js/tools/file-tools.js`（批量重命名两阶段执行）+ `lib/temp-names.js`
- **现象**：两阶段改名（先全部挪成临时名、再统一改成目标名）的暂存名由渲染层**手拼**
  `.hehe-ren-<Date.now()>-<seq><ext>`，而 `lib/temp-names.js` 的 `OWN_TEMP_PATTERNS`
  不认识这种形态。中途崩溃/断电后，文件留在**带前导点的隐藏临时名**下：
  用户看到文件"消失"；`isOwnTempName` 判 false，「清理临时文件」永远扫不到。
- **实测**（`.tmp-r10/verify-ren-tmp.js`）：修复前三种样例全部「不认识(永久残留)」。
- **这正是 temp-names.js 文件头描述的事故形态**（`.hehe-7zx-` 带点漏登记的翻版）——
  「生成与白名单分家」。
- **修复**：
  1. `lib/temp-names.js`：新增 `PREFIX.RENAME_TMP = '.hehe-ren-'` + 白名单正则
     `/^\.hehe-ren-\d{10,}-\d+/i`（时间戳 ≥10 位防误判用户文件）；
     同时提供 `renameTmp(dir, seq, fromPath)` 生成函数供 Node 侧使用。
  2. `js/tools/file-tools.js`：保留本地拼接（渲染层 `nodeIntegration:false` 拿不到
     require，lib/temp-names 又依赖 node 的 path/crypto，不能 `<script>` 引入——
     与 fail-text 的 UMD 方案不兼容），但**形态严格对齐白名单**并统一批次级时间戳
     `REN_TS`（同批可辨识、排序不漂移），注释写明两边必须同步。
  3. `scripts/test-temp-names.js` 新增 RT1：**按 file-tools 源码实际模板造样例**逐个过
     白名单 + 反向断言（字母时间戳/短时间戳不命中）+ 锁批次级时间戳变量。
- **验证**：`test-temp-names` 9/9、`test-fs-ops` 13/13、`test-archive-guard` 30/30、lint/typecheck 0。

### 🟡 记录：暂存名留在用户目录、常规清扫扫不到 —— **本轮已修（崩溃恢复）**
- 方案：批量重命名**执行前**把「暂存名 → 原名」清单写入 store（`renameStaged`），
  每完成一步更新登记；收尾时只剩"真崩溃"的条目。**工具页渲染时**检查登记表，
  有残留就弹说明 + 「一键恢复」（逐条 rename 回原名，失败的留在表里下次再试）。
  恢复是增强功能，失败不影响工具本身。行为路径：执行 → 登记 → 崩溃 → 下次打开工具页 → 一键恢复。

## 二、密码学边界复核（file-crypt / fs-ops cryptStream）

- **布局**：40 字节头（`HEHEENC2` 8 + salt 16 + iv 16）+ 密文 + 16 字节 GCM tag；
  V1（`HEHEENC1`，CBC）兼容解密。
- **复刻验证**（`.tmp-r10/`，三次迭代）：round-trip 一致、篡改 1 字节被 GCM 拦、
  错误密码被拦。
- **审查过程记录（重要）**：前三次复刻"失败"全部是**我的测试脚本 bug**——
  ① magic 写成 7 字节 `HEHECR2`（实现是 8 字节 `HEHEENC2`）；
  ② 漏写源文件；
  ③ 用 `subarray(40, st.size-17)`（左闭右开）复刻 `createReadStream({end})`
  的**闭区间**语义，少读 1 字节。产品代码的区间语义是对的。
  **教训**：复刻验证失败时先查复刻本身——这三条任何一条若当成"产品 bug"去改，
  都会把正确的代码改坏。

## 三、file-tools.js 全量核验（1227 行）

- 批量重命名：冲突三来源检测（组内全标/磁盘已存在/大小写与链式豁免）、
  两阶段执行、失败还原、CSV RFC4180 转义 + BOM、EXIF 64KB 头读取与缓存、
  apply 前重算冲突——逻辑完整；
- 批量改后缀 / 加密解密 / 分割合并 / dedupe / zip / 7z / 全局搜索 / 内容搜索：
  与之前几轮覆盖结论一致，无新问题；
- `es.exe` 参数走 execFile argv（第十轮前已确认）。

## 四、fs-ops.js 深层核验（1289 行）

- `writeFileAtomic`：目标为目录先拒、Windows rename 覆盖语义的 bak 三段式、
  回滚失败必须报 ROLLBACK_FAILED（不静默）——完整；
- `cryptStream`：outPath 双闸门（checkOverwritable + checkFileName）、
  源=输出拒绝（canonical 归一）、cryptTmp `wx` 标志 + cryptOwned 清理、
  V1/V2 分支与最小长度校验——完整；
- `FS.RENAME`：checkOverwritable + 大小写豁免顺序（闸门在前）——完整。

## 五、状态

- 本轮修复改动：`lib/temp-names.js`、`js/tools/file-tools.js`、`scripts/test-temp-names.js`。
- 累计未提交（第 6–10 轮）：源码 4（power-gate/main/css/temp-names+file-tools）、
  测试 3（powergate/restore-point/temp-names）、基线 1、审查记录 5（round6–10）。
- 全量测试基线 2290（本轮新增 RT1，收尾时统一重拍）。
