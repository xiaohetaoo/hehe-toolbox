# 第 22 轮深度审查（2026-11-26，未提交）

版本：`0.9.6`，审查起点 HEAD `18bb3c7`。本轮在 0.9.6 已收口的 R18~R21 基础上继续扫纯逻辑、边界条件与视觉布局，共修复 **6 项**（按收益降序）。

## 一、修复清单

| # | 级别 | 位置 | 问题 | 修复 |
|---|------|------|------|------|
| 1 | P2 | `lib/path-text.js` | 公共 `dirname/basename` 只认普通 `C:` 盘符根，不认 Windows 长路径前缀 `\\?\C:`。实测 `dirname('\\?\C:\foo')` 返回 `\\?\C:`（盘符相对路径），`dirname('\\?\C:\')` 甚至返回 `\\?\`；长路径前缀在 260 字符限制下常见，渲染层用它拼输出目录会拼错 | `DRIVE_ROOT` 同时认 `C:` 与 `\\?\C:`；dirname 补根分隔符，basename 对根返回盘符；路径测试 4→5 条 |
| 2 | P2 | `lib/env-path.js` | `prependEntries` 的 `stripTrailingSep` 同样只认普通盘符；写 PATH 时 `\\?\C:\` 会变成 `\\?\C:`，在长路径场景仍是「C 盘当前目录」 | 盘符根正则加 `\\?\` 前缀，保留 `\\?\C:\`；EP7 行为测试 |
| 3 | P2（安全） | `lib/archive-guard.js` | 文件/目录同名冲突只查了一个方向：先文件 `a`、后目录条目 `a`（无尾斜杠）能通过预检，解压到一半才写盘失败。`seenLower` 对完全同名不报大小写冲突，旧逻辑也没有 `fileDirs → 目录条目` 的对称检查 | 增加 `raw.isDir && fileDirs.has(lower)` 拒绝；test-archive-guard 新增 35 条，实测从「通过」变为 `FILE_DIR_CONFLICT` |
| 4 | P3 | `js/tools/launch.js` | `quicklaunch` 的 store 若有 `null` 项或旧版缺少 `target` 字段，`it.target.length` 在第一张卡就抛，整页后续快捷项全部不显示 | 跳过非对象项；`target`/`name` 统一兜成字符串；R22 源码契约锁住 |
| 5 | P3 | `lib/disk-health.js` | `hasAny` 统计 SMART 读数时漏了 `startStop`。只有启停次数的盘 `hasSmart=true`，但 verdict 仍说「读不到 SMART 明细」，自相矛盾 | `hasAny` 纳入 `startStop`；test-disk-health 新增一条 |
| 6 | P3（视觉） | `css/app.css`、`js/tools/launch.js` | 快捷启动卡在 160px 窄格里显示 40 字符 URL/长名称；`.tc-name/.tc-desc` 没有断行规则，无空格 URL 会横向顶出卡片、压到相邻卡 | 两个类补 `max-width:100%` + `overflow-wrap:anywhere`；R22 源码契约锁 CSS |

## 二、新增 / 修改的测试

- `scripts/test-path-text.js`：新增 `\\?\C:\` 盘符根/尾斜杠/basename 断言。
- `scripts/test-env-path.js`：新增 EP7 扩展长度盘符根。
- `scripts/test-archive-guard.js`：新增 35「先文件后同名目录条目」。
- `scripts/test-disk-health.js`：新增「只有启停次数也算部分 SMART」。
- `scripts/test-round22-fixes.js`（新建，2 条）：S1 快捷启动 null/缺 target；S2 长 URL 卡片断行。
- `scripts/features.json`：`test-round22-fixes.js` 登记进 core。

## 三、验证记录

- `node scripts/test-path-text.js`：5 通过 / 0 失败。
- `node scripts/test-env-path.js`：7 通过 / 0 失败。
- `node scripts/test-archive-guard.js`：31 通过 / 0 失败。
- `node scripts/test-disk-health.js`：23 通过 / 0 失败。
- `node scripts/test-round22-fixes.js`：2 通过 / 0 失败。
- `node scripts/test-source-assertions.js`：6 通过 / 0 失败。
- `npm test`：**217 脚本 / 2437 PASS / 0 失败 / 7 环境跳过**（367.7s，exit 0）。
- `npm run lint`：0；`npm run typecheck`：0。
- 断言基线：**2437 / 217 文件**；`npm run test:count` 已校验（无文件低于基线）。
- `HEHE_SMOKE=1`（隔离 userData + `--no-sandbox --disable-gpu`）：`pages=111 cssRules=498 PASS`；`snip.html/pin.html/ruler.html` 均 `scripts=3, csp=on`。

环境跳过仍为 7 个：`test-dir-move-e2e.js`、`test-dir-move-impl.js`、`test-env-userenv-read.js`、`test-acl-diagnose-e2e.js`、`test-aux-csp.js`、`test-file-unlock-e2e.js`、`test-ui-dpi-fixes.js`。

## 四、明确没做的事 / 遗留

- 111 个工具页只做自动冒烟，没有逐页人工点击拖拽、右键菜单、系统文件选择器；视觉类的长 URL 卡片用 CSS 规则和冒烟共同验证，没有做像素级截图比对。
- `PathText` 仍未专门处理 `\\?\UNC\server\share` 的「共享根」父目录语义（本次只修盘符根；共享根返回自身还是上级取决于 Windows 语义，未扩大）。
- `lib/archive-guard` 对目录条目尾斜杠与无尾斜杠同名的情况，仍优先由大小写冲突规则处理；本次补的是无尾斜杠目录条目。
- `main.js` 的 store 解析失败仍按既有设计：保留损坏副本后继续使用空内存 store，任何一次写入都会覆盖原位文件；这是上一轮确认过的产品取舍，未改。
- 全部改动在工作区，未提交、未 push；`docs/copyright/` 是用户原有未跟踪资料，未触碰。
