# 第九轮代码审查记录（v0.9.0 · ui.js 组件库全量 + app.js 保活/路由 + 测试基础设施 + 布局审计）

> 日期：2026-11-17 · 方式：逐行核验 + 静态扫描（`.tmp-r8/`），不跑实机
> 结论：**未发现新缺陷**。1 项 CSS 一致性修复（第八轮），其余全部确认为既有加固到位。

## 一、ui.js 组件库（1406 行全量逐行）

| 组件 | 核验点 | 结论 |
|---|---|---|
| `h()` 属性分发 | class/html/style/dataset/事件/属性兜底 | 正确 |
| `toast` | 整壳重建后容器重挂（isConnected 检查） | 正确 |
| `modal`/`confirmBox`/`alertBox`/`promptBox` | openOverlays Set 保序、Esc 只关最上层、整壳重建前统一收场、alertBox 对象兼容吵一声 | 正确 |
| `renderTable` | 空 colspan、rows 复制后排序、render 返回 Node/textNode 分流 | 正确；混合类型排序比较器理论上有 UX 瑕疵（sortVal 已给调用方规避口），不改 |
| `switchEl` | role=switch、aria-checked 跟随、禁用三件套（disabled 类 + tabindex=-1 + aria-disabled）、标志位防漏挂 | 正确 |
| `expandDroppedPaths` | 深度语义（边界层文件照收）、触顶布尔上报、顺序展开防 IO 打满 | 正确；`skippedFiles` 恒 0 是死字段（外部消费者自有字段），无害 |
| `dropzone` | picking 防重入（finally 复位）、dragover 不能 getAsFile 只读 entry 元数据、drop 后 stat 复核 | 正确 |
| `fileList` | 体积批量查询（50/批 stat-multi）、refresh 重建前提（rowEnd 重画约定）、locked 不 refresh 只禁按钮、去重 normKey | 正确 |
| `filePicker` | pickProps 透传（历史缺陷有注）、compact 收条、consumePendingDrop 双路径（setTimeout + 显式调用）、dup 字段名 | 正确 |
| `progressEl` | 跨轮复位（到 100% 或数值回退）、<8% 或样本 <3 不显示 ETA | 正确 |
| `guard` | busy 防重入 + finally 必执行 | 正确 |
| `nextId` | 时间戳 + 进程内序号（避免同毫秒撞号） | 正确 |
| `resetShellForRebuild` | 弹窗收场 + toastBox 置空，幂等 | 正确 |

## 二、app.js 路由/保活深层

- **同页重绘判据**：`prevView` 为 null 或同视图 → 丢弃保活重建（防"能力已开启还显示占位卡"）；
- **淘汰不清理**：`evictOne` 只删引用不调 `runPageCleanup`（防"第 7 个标签自己停住"），有测试锁着；
- **保活复用接拖拽/剪贴板**：显式传 `v.toolId`（防 `__renderingTool` 错位）、setTimeout(0) 等 DOM 贴回；
- **async renderToolPage**：`.then` 里校验 `state.view` 仍是本工具才登记保活（防快速切换错位）；渲染异常兜底卡 + 返回首页按钮；
- **Prefs**：按键写入（防多窗口整对象覆盖回滚）、`normalize` 统一入口。
- 结论：无新问题。

## 三、测试基础设施

- `harness.js`：deferred/sequential 双模型、0 用例即 FAIL（防测试静默消失）、异步用例 done 必等、FAIL 单行化（CI grep 口径）、readTree/readMain 分隔注释防粘连；
- `check-assertion-count.js`：只走 run-tests.js 单一路径（口径统一）、--no-run 补 EXIT_ONLY 刻度、SKIP 不判红但必须打印、未登记基线且 0 条也判红。
- 结论：两层护栏逻辑完备，无绕过面。

## 四、布局一致性审计（静态扫描 `.tmp-r8/scan-layout.js`）

- 内联 style 热点：`sys-tools.js` 65 处最多，但抽查均为数值对齐/进度条尺寸类，无绕过主题的硬编码前景色（CSS 扫描器确认剩余 20 处 hex 全在主题定义区或终端仿真区）；
- 固定宽度元素：均为表格列宽（`.table-scroll` 横向滚动兜底）与紧凑输入框（form-row 可换行），第六/七轮 CDP 实测 860px 窄窗无溢出——**无真实挤压缺陷**；
- 结论：不需要布局改动。批量内联样式收敛属于重构级工程（收益低、回归面大），不做。

## 五、全量验证

- **205 脚本 / 2290 PASS / 0 失败 / 3 环境跳过**，lint 0 / typecheck 0，断言基线 2290（本轮改动无新断言，无需重拍）。
- CSS 修复验证：`test-ui-consistency` 5/5、`test-css-vars` 3/3、`test-css-responsive` 1/1。

## 六、累计未提交改动（第 6/7/8 轮）

| 文件 | 内容 |
|---|---|
| `lib/power-gate.js` | P0：Get-Command 间接执行绕过修复（第六轮） |
| `scripts/test-powergate.js` | t27 回归（第六轮） |
| `main.js` | P1：restore-delete mode 白名单（第七轮） |
| `scripts/test-restore-point.js` | RP8 回归（第七轮） |
| `css/app.css` | btn-danger hover 主题化（第八轮）+ .term 注释 |
| `scripts/assertions-baseline.json` | 2290 |
| `docs/review-round{6,7,8,9}.md` | 四轮审查记录（本文件为第九轮） |

均为**未提交**状态。
