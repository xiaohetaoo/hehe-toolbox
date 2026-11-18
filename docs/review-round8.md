# 第八轮代码审查记录（v0.9.0 · CSS/主题一致性 + 渲染层 + i18n + dir-acl 深扫）

> 日期：2026-11-17 · 方式：静态扫描（脚本留 `.tmp-r8/`）+ 逐行核验，不跑实机
> 本轮发现均为**低收益**问题（项目经过七轮加固），修复 1 项 CSS 一致性 + 1 项注释补充。

## 发现与修复（收益降序）

### 🟡 1. `.btn-danger:hover` 硬编码 `#F76560`，绕过主题槽位（已修）
- 位置：`css/app.css:886`
- 问题：`.btn-danger` 本体用 `var(--danger)`，hover 却写死 `#F76560`。项目有 9 套配色 × 明暗正交，
  `--danger` 在纯黑白等主题下有不同值，hover 色不跟随就是「按钮 hover 变成另一套红」。
  同时 `#F76560` 与 `--danger`(#F53F3F) 仅是亮度差，用 `color-mix`/`brightness` 语义更准。
- 修复：改为 `background: var(--danger); filter: brightness(1.06);` —— hover 永远是「本主题危险的变亮」。
- 验证：`test-ui-consistency` 5/5、`test-css-vars` 3/3、`test-css-responsive` 1/1、lint 0。

### 🟡 2. `.term` 终端硬编码深底彩字（确认为**有意设计**，补注释防误改）
- 位置：`css/app.css:1041-1048`
- 判定：终端仿真语义上就该固定「深底 + 绿字/蓝高亮/红错误」——这是所有终端的通用约定，
  跟随主题在浅色下会变成白底绿字没法读。非缺陷，但原代码无注释，下轮扫描器会再报一次。
- 修复：补注释说明「不走主题槽位是有意的」。

### 排除的疑似（实测确认无问题）
- `--d-text-*` 等行内 hex：都在主题定义区（扫描器误报，`--` 前缀行实际是定义行）；
- 渲染层「await 结果立即被覆盖」：唯一命中是 `launch.js` 的 prompt→String 转换，非 bug；
- `invoke` 未 await：两处命中均有 `.catch(() => {})`（跨行，扫描正则没抓到），fire-and-forget 是设计；
- toast 类型拼写：全项目 0 处非法值；
- 长英文漏翻：唯一命中是正则误报（`btn('复制 UUID', 'btn-secondary')`）。

### dir-acl-links.js 深扫（1782 行，此前只查过部分）
- `rmQueryLockers`：分块 + 块错误聚合 + 全块失败才抛——语义正确；
- `restoreLinksIntoTarget`：链接改写（8.3 短名）、同名项清理记账、stat 判活——加固完整；
- `acl:repair`：`buildRepairCommands` 产出 argv 数组走 `runCmd`（execFile，无 shell），
  `isProtectedForModify` 分情形拒绝、admin 三态（null 拒绝）、`me` 取不到即放弃——完整；
- 未发现新问题。
