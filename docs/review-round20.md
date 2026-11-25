# 第 20 轮深度审查（2026-11-25 凌晨，未提交）

范围：`main.js` 的定时 / TTS / 7z / 贴图窗口路径，`js/tools/text-tools.js` 本地笔记，`js/clip-actions.js` 路径动作，`lib/once-schedule.js`、`lib/safe-name.js`。本轮共修复 **11 项**，按收益降序排列。

## 一、修复清单

| # | 级别 | 位置 | 问题 | 修复 |
|---|------|------|------|------|
| 1 | P1 | `js/tools/text-tools.js` | 切换笔记 / 新建时直接覆盖 `ta.value`，未保存的正文、标题、标签无提示丢失；自动保存只对已存在笔记且 30 秒一次 | 新增 `snapshot()/isDirty()/confirmDiscard()`；`openNote`、`createNew` 先确认，保存成功后重设快照 |
| 2 | P1 | `main.js` `armOnceAll/armOnce` | `fireAt` 损坏成 `"abc"/NaN` 时既不是假值、也不 `<= now`，被当未来任务挂 `setTimeout(NaN)` = 1ms，**启动即执行睡眠/锁屏** | 新增 `lib/once-schedule.js`：只接受正有限时间戳，坏项 drop；`armOnce` 再守一道 |
| 3 | P1 | `main.js` `runOnceAction` | `else` 分支无条件睡眠，store 里 `action` 被改成未知值时到点仍会挂起电脑 | 只显式处理 `lock/sleep`，未知动作记日志跳过；`armOnceAll` 同步过滤未知 action |
| 4 | P2 | `main.js` `TTS.WAV` | `SetOutputToWaveFile` 直接创建/截断目标文件，合成中途失败会把用户原有同名 WAV 截成半截；且没过覆盖闸门 | 先写 `.hehe-w-*.wav` 临时文件，成功后 `readFile + writeFileAtomic(out)`；失败只删临时件 |
| 5 | P2 | `main.js` `TTS.SPEAK` | `rate/volume` 非数字会拼出 `[int]NaN`，PowerShell 抛错；`ttsEsc(null)` 会朗读字面 `null` | 新增 `ttsInt()` 夹取，`ttsEsc` 对 null/undefined 返回空串 |
| 6 | P2 | `main.js` `SEVEN.COMPRESS` | `volumeMB` 为 `"abc"/Infinity` 时拼出 `-vNaNm`，7z 直接失败；非正数语义不明 | 先 `Number` + 有限数校验，非法值明确报错；`split` 只由正数触发 |
| 7 | P2 | `main.js` `createPinWindow` | 贴图源图是 `snipTmp()` 生成的临时 PNG，窗口关闭后只从 Map 删除，文件留到启动 24h 清扫 | `closed` 时用 `isOwnTempName(basename)` 判定后删除，用户文件不碰 |
| 8 | P2 | `js/tools/text-tools.js` `removeCur` | 删除笔记 `.catch(() => {})` 吞错后照样清空编辑区，文件其实还在 | `try/await`，失败 toast 并保留当前编辑状态 |
| 9 | P2 | `main.js` `armAllSchedules/SCHED.ADD/REMOVE` | store 被手改成 `null`/对象时，`for...of` 或 `.push/.filter` 在启动阶段抛错；坏项还会拖垮后续初始化 | 非数组兜底为空数组；`armAllSchedules` 逐条 `try` 隔离，坏项跳过 |
| 10 | P3 | `js/clip-actions.js` / `lib/safe-name.js` | `C:\foo` 的“所在目录”算成 `C:`（盘符相对路径）；目录带尾斜杠时“复制文件名”为空；超长无扩展名截断可能停在空格，Windows 落盘后名字与返回值不一致 | `pathDir/pathName` 先剥尾分隔符、盘符根补 `\`；`fromUrl` 截断后再剥尾点/空格 |
| 11 | P2 | `js/tools/text-tools.js` TTS 导出 | 导出按钮一直按默认音量 100 合成，界面音量滑块对文件无效；且没有长度上限，整段 5 万字会一次性塞给 PowerShell 合成，内存和耗时都不可控 | 传 `volume: +volIn.value`；导出前拦 5000 字并提示分段 |

## 二、新增 / 修改的测试

- `scripts/test-once-schedule.js`（新建，7 条）：`fireAtOf` 只接受正有限数；`decideOnce` 对坏时间戳 drop、未来 keep、补执行窗口 run、过期太久 drop；`now/catchup` 非数字不抛。
- `scripts/test-round20-fixes.js`（新建，11 条）：S1–S10 + S6b 源码契约，逐条注明“锁的是”哪个回归、为什么不能用纯行为测试替代；S11（自启备份数组兜底）在第 21 轮追加。
- `scripts/test-safename.js`：新增 1 条硬截断尾空格回归。
- `scripts/features.json`：登记 `lib/once-schedule.js`、`test-once-schedule.js`、`test-round20-fixes.js`。

## 三、验证记录

- `node scripts/test-once-schedule.js`：7 通过 / 0 失败。
- `node scripts/test-round20-fixes.js`：12 通过 / 0 失败。
- `scripts/test-safename.js`：24 通过 / 0 失败。
- `scripts/test-schedule.js`：4 通过 / 0 失败。
- `scripts/test-source-assertions.js`：6 通过 / 0 失败。
- `npm test`：**216 脚本 / 2430 PASS / 0 失败 / 7 环境跳过**（349.7s，exit 0；含第 21 轮追加的路径/PATH/启动项测试）。
- `npm run lint`：0；`npm run typecheck`：0。
- `npm run test:count:write`：total=2430（216 文件）；`npm run test:count`：PASS，无文件低于基线。
- `HEHE_SMOKE=1`（隔离 userData + `--no-sandbox --disable-gpu`）：`pages=111 cssRules=498 PASS`；`snip.html/pin.html/ruler.html` 均 `scripts=3, csp=on`；渲染进程无 error/warning。

环境跳过仍为 7 个：`test-dir-move-e2e.js`、`test-dir-move-impl.js`、`test-env-userenv-read.js`、`test-acl-diagnose-e2e.js`、`test-aux-csp.js`、`test-file-unlock-e2e.js`、`test-ui-dpi-fixes.js`。

## 四、未做 / 遗留观察

- 本地笔记在“直接切到另一个工具页”时仍可能丢掉**新建且从未保存**的草稿：`App.onCleanup` 是同步回调，弹异步确认已来不及；已保存过的笔记有 30 秒自动保存兜底。若要彻底解决，需要草稿自动落盘（如 `notes/.draft-*`）或输入防抖保存，涉及产品取舍，本轮未动。
- `SNIP action='ocr'` 生成的临时 PNG 仍只由 OCR 工具读取、不主动删除，依赖启动 24h 清扫；删早了会让“重新识别”失败，暂不收紧。
- `AUTOSTART.DELETE/ENABLE` 仍信任渲染层传入的 `item.key/name/cmd`；渲染层本身已有 `EXEC.STREAM`，这层不构成新的权限边界，暂未改。
- `armSchedule` 对损坏的 `daily/clean` 的 `hhmm` 会退回 09:00（不会误触发，只是时间不对），未改。
