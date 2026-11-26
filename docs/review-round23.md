# 第 23 轮深度审查（2026-11-26，未提交）

版本 `0.9.6`，起点为包含 R22 未提交改动的工作区。本轮继续扫路径/PATH 语义、归档预检、磁盘健康数据质量、快捷启动旧数据，共修复 **6 项**（按收益降序）。

## 一、修复清单

| # | 级别 | 位置 | 问题 | 修复 |
|---|------|------|------|------|
| 1 | P2（安全） | `lib/archive-guard.js` | 文件条目 `size` 缺失、空串、`'abc'`、`NaN`、`Infinity` 时，`Number(raw.size) \\|\\| 0` 全部当成 0：单条与累计上限被绕过，adm-zip 仍可能按归档里的真实声明分配内存 | 文件条目只接受有限非负数；坏大小抛 `BAD_SIZE`，负数保留 `NEGATIVE_SIZE`；目录条目不参与解压，允许没有 size。新增 36 号测试，6 种坏大小全部拒，空文件/目录仍放行 |
| 2 | P2 | `lib/disk-health.js` | `Number('')=0`、`Number(' ')=0`，空字段被当成有效读数；`'abc'`/`NaN`/`Infinity` 又不是 null。结果：`hasSmart` 误判为「有数据」、温度显示 0°C，verdict 甚至会输出「累计读写错误 Infinity 次」 | 新增 `numOrNull`：数字/非空数字串且有限才保留，其余回 null；`hasSmart`/`verdictOf` 同步按有限数判断；`estimateRemaining('')` 不再当 0%；`shape` 对 `disks` 非数组、`null` 项也不再抛 |
| 3 | P2 | `lib/env-path.js` | `normalizeForCompare` 一律剥尾分隔符，`C:`（盘符当前目录）和 `C:\`（盘符根）都变 `c:`：PATH 已有 `C:` 时会误判根已存在、不加根；`removeEntries('C:\\')` 还会删掉 `C:` 项。另，`prependEntries` 先去重再 strip，`C:\Tools`/`C:\Tools\`/`C:/Tools` 会加两遍 | 盘符根保留尾部 `\`，普通路径才剥；`/` 统一成 `\` 再比较；`prependEntries` 改成「先 strip 再按语义去重」。EP8 覆盖根/相对区分与三写法归并 |
| 4 | P3 | `js/tools/launch.js` | 快捷启动默认名用 `/\.\\w+$/`，实际匹配的是「点 + 反斜杠 + w」，对 `报告.docx` 不命中，弹窗永远带扩展名；URL 还把 `?x=1` 带进名字。旧/坏 store 含 `null` 项时删除会抛；命令收藏含缺 `cmd` 的项会把 `undefined` 交给 `cmd /c` | 文件按最后一个点切、只切 `dot>0`（保留 `.gitignore`）；URL 先剥 `?/#`；快捷项/命令项先过滤坏对象，全坏时显示空状态；删除 findIndex 跳过 null；添加前把非数组 store 兜成 `[]` |
| 5 | P3 | `lib/path-text.js` | UNC 共享根 `\\server\share` 走通用「最后一个分隔符」分支，`dirname` 返回 `\\server`（主机名不是目录）；`\\?\UNC\...` 同样 | 新增 `UNC_ROOT`，共享根返回自身（保留输入尾部斜杠）；普通 UNC 子路径与 `\\?\C:\` 行为不变 |
| 6 | P3（视觉） | `js/tools/launch.js` | 快捷项全是坏数据时渲染空网格，没有「还没有快捷项」提示；这与「有数据但都是坏项」在视觉上无法区分 | 先 filter 再判空，复用同一空状态提示；与第 4 项同一处修复 |

## 二、新增 / 修改的测试

- `scripts/test-archive-guard.js`：新增 36，6 种坏大小 + 空文件/目录对照（32 通过）。
- `scripts/test-disk-health.js`：新增 32、33，空串/空白/NaN/Infinity 与坏数组/坏条目（25 通过）。
- `scripts/test-env-path.js`：新增 EP8，盘符根 vs 盘符相对、三写法归并（8 通过）。
- `scripts/test-path-text.js`：新增 UNC 共享根（6 通过）。
- `scripts/test-round23-fixes.js`（新建，2 条）：默认名推导、坏 store 过滤/空状态/命令项过滤。
- 同步调整 `scripts/test-round22-fixes.js` 的 S1：R22 的 `if continue` 已改为先 filter；断言改成等价的 filter 形态，语义不变。

## 三、验证记录

- 单测：archive 32/32、disk-health 25/25、env-path 8/8、path-text 6/6、round23 2/2、round22 2/2。
- `npm run lint`：0；`npm run typecheck`：0。
- `npm test`：**218 脚本 / 2444 PASS / 0 失败 / 7 环境跳过**（371.1s，exit 0）。
- 断言基线：**2444 / 218 文件**；`npm run test:count` 校验通过。
- 冒烟：`HEHE_SMOKE=1` 隔离 userData，Electron `--no-sandbox --disable-gpu`：`pages=111 cssRules=498 PASS`；`snip.html/pin.html/ruler.html` 均 `scripts=3, csp=on`。

## 四、明确没做的事 / 遗留

- 111 个工具页仍只做自动冒烟，没有逐页人工点击拖拽、右键菜单、系统文件选择器；快捷启动的空状态与长文本只做了源码契约/冒烟，没有像素级截图比对。
- `archive-guard` 仍不拒绝「同名文件条目出现两次」；解压时后写覆盖前写，不构成目录穿越，但会静默丢一份内容，是否拒绝需产品决定。
- `env-path` 对 UNC/相对路径的 PATH 项只做大小写与分隔符归一，不解析 `.`/`..`；Windows PATH 通常不写这些形式。
- `path-text` 的 UNC 共享根只处理 `\\server\share` 与 `\\?\UNC\server\share`，不处理 `\\?\GLOBALROOT` 等设备命名空间。
- 全部改动在工作区，未提交、未 push；`docs/copyright/` 为用户原有未跟踪资料，未触碰。
