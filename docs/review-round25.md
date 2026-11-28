# 第 25 轮：接管后的深度静态审查

日期：2026-11-26
范围：`D:\zcode\hehe`，hehe-toolbox 0.9.7，HEAD `979c03f` + 工作区未提交改动
约束：只读代码/静态检查，不启动 Electron、不跑真实交互；不派子代理；不 push；不碰 `docs/copyright/`。

## 结论

本轮在 R24 未提交改动的基础上继续审查，确认并修复了一批“坏输入会静默成功 / 留下幽灵任务 / 目录边界判断错误 / 窄窗布局越界”的问题。所有修改均未提交，等待验收。

- `npm run lint`：0
- `npm run typecheck`：0
- `npm run test:unit`：188 个脚本，PASS 2109，环境跳过 3，全部通过
- `scripts/test-round25-fixes.js`：26 条，全部 PASS
- `scripts/test-source-assertions.js`：6 条，全部 PASS
- `scripts/test-crypt-guard.js`：6 条，全部 PASS

## 一、路径与文件写入闸门

1. `lib/path-guard.js`
   - 新增 `isDriveRelativePath`，统一识别 `C:foo`、`D:foo` 这类“盘符相对路径”。
   - `checkDeletable`、`checkOverwritable`、`isProtectedForModify` 三处一致拒绝，避免 `path.resolve('C:foo')` 落到盘符当前目录。
   - `checkOverwritable` 额外拒绝盘符根。
2. `ipc/fs-ops.js`
   - `FS.RENAME`：在 `path.resolve` 之前用原始字符串拒绝盘符相对路径；源路径补删除闸门。
   - `FS.MKDIR`：修正把 `isProtectedForModify` 返回对象当布尔使用的问题。
   - `FS.SPLIT`：校验分卷大小；`FS.MERGE_PARTS` 改为 `mergedBytes !== declSize` 严格校验（空文件也必须为 0），唯一名 1000 次仍冲突时明确抛错。
   - `CH.ZIP.COMPRESS`：校验 `paths` 为非空数组、每项为非空字符串、输出名合法；`CH.ZIP.EXTRACT` 缺失 `header.size` 时不再补 0。
   - `FS.SCAN_TREE`：先 `normalizeRootForScan` 再 `jobs.set`；`maxDepth` 用 `??`，允许传 0；`walkDir` 的 `maxDepth` 先归一为有限非负整数；遍历跳过链接。
   - `FS.SCAN_EMPTY_DIRS`：跳过符号链接/junction；**不再把用户选中的扫描根列进待删清单**。
   - `FS.SCAN_JUNK` / `FS.CLEAN_JUNK`：安装包与缓存扫描跳过链接；清理前先 `lstat`，链接只删链接本身；`%TEMP%` 前缀比较大小写不敏感。
   - `FS.DEDUPE`：拒绝未知模式；完整哈希阶段单个文件被删/锁定时跳过，不再让整轮查重失败。
   - `FS.HASH_TEXT_MULTI`：`algos` 非数组/空数组时回落到 `sha256`，不再把字符串当字符迭代。
   - 加密/解密：空密码统一拒绝；进度推送加 200ms 节流，避免大文件刷爆渲染层。
3. `main.js`
   - `TTS.WAV` 在 `mkdir`/合成前过覆盖闸门；`SEVEN.EXTRACT` 目标目录闸门与失败回滚；`SEVEN.COMPRESS` 拒绝已存在目标。
   - `loadStore` 使用 JSON reviver 去掉 `__proto__/constructor/prototype`；`STORE.SET` 主进程敏感键黑名单。
   - `APP.SET_THEME` 与启动主题夹到 `system/light/dark`。
   - `hosts:write` / `hosts:restore` 共用串行锁，避免固定临时文件交错。
   - `NOTES.PDF`：输出路径过覆盖闸门；非保存对话框直传的已存在文件拒绝覆盖。
   - 静态 HTTP 服务：修正根目录以分隔符结尾时 `D:\\` 前缀拼接错误，`D:\` 作为站点根不再把所有子文件判为越界。
   - `PROC.DETAIL`：PID 必须是正整数，避免 `NaN` 进入 PowerShell 过滤器。
   - `SCHED.ONCE_ADD`：未知动作拒绝，不再静默映射成 sleep。
   - 启动临时清扫：先 `lstat`，`hehe-*` 链接/junction 只删链接本身。
4. `ipc/media-ffmpeg.js`
   - `assertOutDir` 统一拒绝系统位置/盘符根；TRIM/AUDIO_CUT 用 canonical 同源判断。
   - `TARGET.COMPRESS_AV` / `CONVERT` / `PRESS`：先校验并创建输出目录，再 `jobs.set`，非法目录不再留下幽灵任务。
   - `FFMPEG.DOWNLOAD`：`mkdir(binDir())` 先于 `jobs.set`；临时名带 job id；zip 条目做穿越检查与大小上限。
   - `AUDIO_CUT` 的 `ss/dur/fadeIn/fadeOut`、`FRAMES` 的 `width/every/count/ss`、`REC.START` 的 `fps/rect/camScale/camPos`、`CONVERT` / `PRESS` 的数值参数统一归一或拒绝。
   - `REC.PAUSE` 无会话时明确报错；`REC.START` 校验失败不再提前改写全局 `recOut`。
5. `ipc/env-manager.js`
   - `isSafeEnvDir(dir,id)` 只接受 `<ENV_ROOT>/<id>/...`，manifest 不能指向 `envs/downloads`、staging。
   - `appliedGet` 将坏 `ids/entries` 归一成字符串数组；`sweepEnvRoot` 跳过符号链接。
6. `lib/download.js`
   - 续传打开分片后核对 `stat.size === got`；外部删除/截断时重置偏移，避免 `open('a')` 静默新建空文件后只写后半段。
7. `lib/archive-process.js`
   - 轮询 watchdog 容忍根目录暂时不存在，但**最终复查不容忍**根目录缺失；`child.on('error')` 直接 reject 并清定时器。
8. `lib/archive-guard.js`
   - 设备名判断对基本名做 `trim()`，拒绝 `CON .txt` 这类带空格的保留名。
9. `lib/update-file.js`
   - PE 头校验与 SHA-256 摘要改为同一个已打开的文件句柄，消除“校验一个文件、哈希另一个文件”的替换窗口。

## 二、网络与任务生命周期

1. `ipc/net-lan.js`
   - `NET.HTTP` 增加 64MB 流式读取上限；超限主动 `reader.cancel()`，避免公开 URL 把主进程内存拖死。
   - `NET.SCAN` 端口去重；进度总数改用去重后的列表长度。
   - `NET.SPEEDTEST` 采满时间窗后主动取消响应流，不再后台继续下载。
   - `LAN.SCAN` 的 job 保留到反查主机名结束，反查阶段点“取消”才真正有效；ping 阶段意外失败仍会回收 job。
2. `lib/lan-scan.js`
   - `subnetOf` / `isPrivateIp` 拒绝空段（`1.2.3.`、`10..1.1`），不再被 `Number('')` 当成 0。

## 三、测试与 UI

1. 新增 `scripts/test-round25-fixes.js`，26 条回归，覆盖上述路径闸门、任务生命周期、解压最终复查、空目录扫描根、窄窗布局、IP 解析、HTTP 上限、一次性动作、临时清扫链接等。
2. `scripts/test-crypt-guard.js` 改为按 `cryptStream` 完整函数体取片段，避免新增注释把 `pipeline` 推出固定 3000 字符窗口造成假失败。
3. CSS：
   - `@media (max-width:760px)`：设置页侧栏改横向可滚、内容满宽、`set-row` 可换行。
   - `@media (max-width:680px)`：工具窗内容留白收到 14/16/18。
   - 标题栏搜索下拉改为 `left:max(20px, calc(50% - 280px))` + `width:min(560px, calc(100vw - 40px))`；视口小于 560px 时不再左侧越界。
4. `package.json`：asar 文件列表排除 `node_modules` 下的 `.ts`、`.d.ts`、`README*`、`CHANGELOG*`，减少安装包体积；未排除 `src/`，因为已确认存在入口在 `src/` 的依赖。

## 四、仍未处理 / 留待后续

以下问题本轮已确认，但没有在“静态审查、不跑实机”的约束内安全落地，留待后续单独处理：

- R24-45：release 与内置 updater 两条更新路径仍存在口径分叉。
- R24-51：`jsconfig.json` 仍未覆盖 `main.js`、`preload.js` 与渲染层；直接纳入会产生大量既有类型错误。
- R24-43：辅助窗（`pin.html` 等）仍有未逐字符串翻译的中文提示。
- `scripts/test-i18n-assertions.js` 只扫 `scripts/` 顶层，未递归；`source-assert-scan.js` 的递归范围也未同步调整。
- `HOSTS.BACKUP` 未纳入 hosts 串行锁；它只读 hosts 后写唯一备份文件，读到旧/新整文件都可接受，暂未加锁。
- UI 固定宽度候选（`settings-nav 180`、`modal min-width 360`、`env-manager 150/160`、`file-tools 110–230`、`launch 160`）已逐项核对，当前窗口最小宽度下未发现新的溢出；仍建议后续用真实窗口截图复核。

## 五、验收命令

```powershell
npm run lint
npm run typecheck
npm run test:unit
node scripts/test-round25-fixes.js
node scripts/test-source-assertions.js
node scripts/test-crypt-guard.js
npm run test:count
```
