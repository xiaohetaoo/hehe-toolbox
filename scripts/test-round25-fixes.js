'use strict';
/* 第 25 轮（接管后的深度审查）回归。
 *
 * 这一轮只做静态代码审查，不启动 Electron，也不跑实机交互；因此：
 *   · 纯函数/可注入依赖的路径尽量写成行为断言；
 *   · 网络下载、系统 hosts、zip/7z 解压这类需要真实环境的，锁源码形态，
 *     并逐条写明锁的是哪个历史回归、为什么不能行为断言。
 */
const assert = require('assert');
const { t, done, readSrc, readMain } = require('./lib/harness');
const PG = require('../lib/path-guard');

t('R25-01 盘符相对 C:foo / D:foo 在删除、覆盖、改权限三处一致拒绝', () => {
  for (const p of ['C:foo', 'D:foo', ' C:temp ']) {
    const del = PG.checkDeletable(p);
    const ow = PG.checkOverwritable(p);
    const mod = PG.isProtectedForModify(p);
  /* 锁的是：R25-01 盘符相对 C:foo / D:foo 在删除、覆盖、改权限三处一致拒绝（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
    assert.ok(del && del.code === 'DRIVE_RELATIVE', 'checkDeletable 放行了 ' + p);
    assert.ok(ow && ow.code === 'DRIVE_RELATIVE', 'checkOverwritable 放行了 ' + p);
    assert.strictEqual(mod.protected, true, 'isProtectedForModify 放行了 ' + p);
  }
  /* 锁的是：R25-01 盘符相对 C:foo / D:foo 在删除、覆盖、改权限三处一致拒绝（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
  assert.strictEqual(PG.checkDeletable(require('path').join(require('os').tmpdir(), 'hehe-r25-normal.txt')), null,
    '正常绝对路径不能被误伤');
});

t('R25-02 dir-move 的预检与执行都先过同一个路径入口闸门', () => {
  const code = readSrc('ipc/dir-acl-links.js');
  /* 锁的是：空路径会被 path.resolve('') 变成应用 cwd；C:foo/D:foo 会被
   * 解析成盘符当前目录。这两个值都不能进入搬家流程。
   * 行为用例 test-dir-move 的 35 号直接执行 requireMovePaths；这里补的是
   * 「两个 handler 都接线了」这个无法靠纯函数验证的调用点。 */
  /* 锁的是：R25-02 dir-move 的预检与执行都先过同一个路径入口闸门（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
  assert.ok((code.match(/requireMovePaths\(src, dst\)/g) || []).length >= 2,
    '预检与执行没有都调用 requireMovePaths');
});

t('R25-03 zip 清单缺失 size 时不再补 0 放行', () => {
  const code = readSrc('ipc/fs-ops.js');
  const start = code.indexOf('CH.ZIP.EXTRACT');
  const seg = code.slice(start, start + 1300);
  /* 锁的是：header.size 缺失时若补 0，archive-guard 会把它当成合法 0 字节
   * 条目，ZIP 预检在真正解压前失效。行为测试需要构造 AdmZip 不返回
   * header.size 的畸形包，adm-zip 本身不提供这种入口；故锁源码。 */
  assert.ok(/size:\s*en\.header\s*&&\s*typeof\s+en\.header\.size\s*===\s*'number'\s*\?\s*en\.header\.size\s*:\s*undefined/.test(seg),
    'zip 预检仍把缺失 size 补成 0');
  /* 锁的是：R25-03 zip 清单缺失 size 时不再补 0 放行（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
  assert.ok(/isProtectedForModify\(outDir\)/.test(seg), 'zip:extract 没有保护目标目录');
});

t('R25-04 7z 解压同样拒绝系统位置/盘符根作为目标', () => {
  const code = readMain();
  const start = code.indexOf('CH.SEVEN.EXTRACT');
  const seg = code.slice(start, start + 900);
  /* 锁的是：R25-04 7z 解压同样拒绝系统位置/盘符根作为目标（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
  assert.ok(/isProtectedForModify\(outDir\)/.test(seg), 'seven:extract 没有保护目标目录');
});

t('R25-05 下载 token 只发给 api.github.com，且先校验后改名', () => {
  const code = readSrc('scripts/fetch-dist.js');
  /* 锁的是两个真实缺陷：
   * 1) 镜像 ghfast.top 也收到 Authorization: token → GitHub 凭据泄漏；
   * 2) rename(tmp, dest) 在大小/哈希校验之前 → 坏下载会覆盖旧产物。
   * fetch 需要联网和 Release 资产，不能在单测里真跑；这里锁调用顺序。 */
  /* 锁的是：R25-05 下载 token 只发给 api.github.com，且先校验后改名（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
  assert.ok(/u\.hostname\.toLowerCase\(\)\s*===\s*'api\.github\.com'\s*&&\s*tok/.test(code),
    'Authorization 没有按 host 限制');
  assert.ok(code.indexOf('bytes !== expectedSize') < code.indexOf('fs.renameSync(tmp, dest)'),
    'rename 发生在大小校验之前');
  /* 锁的是：R25-05 下载 token 只发给 api.github.com，且先校验后改名（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
  assert.ok(code.indexOf('expectedSha && digest !== expectedSha') < code.indexOf('fs.renameSync(tmp, dest)'),
    'rename 发生在哈希校验之前');
});

t('R25-06 hosts 写入/还原串行化，避免共用固定 tmp 交错', () => {
  const code = readMain();
  /* 锁的是：两个窗口同时点「应用」时共用 hosts.hehe.tmp / restore.tmp，
   * A 写一半 B 覆盖，随后 rm/rename 交错可短暂删掉系统 hosts。
   * 真并发要两个 BrowserWindow 同时 invoke，属于实机场景；此处锁接线。 */
  assert.ok(/function withHostsLock/.test(code), '缺少 withHostsLock');
  /* 锁的是：R25-06 hosts 写入/还原串行化，避免共用固定 tmp 交错（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
  assert.ok((code.match(/withHostsLock\(async\s*\(\)\s*=>\s*\{/g) || []).length >= 2,
    'hosts:write / hosts:restore 未都接入串行锁');
});

t('R25-07 扫描根空串/盘符相对不能落到应用 cwd', () => {
  /* 行为断言：直接执行 normalizeRootForScan，原先空串会 path.resolve('')。
   * 现在在函数入口拒绝；这条同时保护 scan-tree / scan-empty-dirs / dedupe。 */
  const code = readSrc('ipc/fs-ops.js');
  const start = code.indexOf('function normalizeRootForScan');
  const end = code.indexOf('handle(CH.FS.SCAN_EMPTY_DIRS');
  const fn = new Function('path', code.slice(start, end) + '\nreturn normalizeRootForScan;')(require('path'));
  /* 锁的是：R25-07 扫描根空串/盘符相对不能落到应用 cwd（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
  assert.throws(() => fn(''), /不能为空/);
  assert.throws(() => fn('   '), /不能为空/);
  assert.throws(() => fn('C:foo'), /盘符相对/);
  /* 锁的是：R25-07 扫描根空串/盘符相对不能落到应用 cwd（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
  assert.strictEqual(fn('D:\\foo\\'), 'D:\\foo');
});

t('R25-08 UI：表单行允许收缩、长文本可断行，测速统计列可压缩', () => {
  const css = readSrc('css/app.css', { raw: true });
  const net = readSrc('js/tools/net-tools.js');
  /* 锁的是窄工具窗（最小 560px）里长路径/长便签撑出横向滚动条：
   * flex 子项 min-width:auto 会让整行无法收缩。源码断言足够，因为
   * 这是纯布局规则，无法在无头 DOM 里稳定测量像素。 */
  assert.ok(/.form-row > \*:not\(button\):not\(.btn\) \{ min-width: 0; \}/.test(css),
    '缺少 form-row 子项收缩规则');
  /* 锁的是：长路径/长文本在 span 里必须能断行，不能撑出横向滚动条。 */
  assert.ok(/.form-row > span \{ overflow-wrap: anywhere; \}/.test(css),
    '缺少 span 长文本断行规则');
  /* 锁的是：R25 原本要求 5 列可压缩；R28 进一步改为 auto-fit 100px 下限，
   * 窄窗自动落成 4 列、宽窗仍 5 列，仍然不允许把内容挤成固定宽柱。 */
  assert.ok(/repeat\(auto-fit, minmax\(100px, 1fr\)\)|repeat\(5, minmax\(0, 1fr\)\)/.test(net), '测速统计仍用不可压缩的等分列');
});

t('R25-09 scan-tree 先归一化再登记 job，非法根不再泄漏任务', () => {
  const code = readSrc('ipc/fs-ops.js');
  const start = code.indexOf('CH.FS.SCAN_TREE');
  const seg = code.slice(start, start + 500);
  const normAt = seg.indexOf('normalizeRootForScan(root)');
  const jobsAt = seg.indexOf('jobs.set(id');
  /* 锁的是：R25-09 scan-tree 先归一化再登记 job，非法根不再泄漏任务（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
  assert.ok(normAt >= 0 && jobsAt > normAt, 'scan-tree 仍在 jobs.set 之后才校验根路径');
});

t('R25-10 空目录扫描/垃圾扫描不跟随 junction', () => {
  const code = readSrc('ipc/fs-ops.js');
  const empty = code.slice(code.indexOf('CH.FS.SCAN_EMPTY_DIRS'), code.indexOf('CH.FS.DELETE_EMPTY'));
  /* 锁的是：R25-10 空目录扫描/垃圾扫描不跟随 junction（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
  assert.ok(/if \(d\.isSymbolicLink\(\)\) \{ hasFile = true; continue; \}/.test(empty),
    'scan-empty-dirs 会递归进 junction');
  const junk = code.slice(code.indexOf('CH.FS.SCAN_JUNK'), code.indexOf('CH.FS.CLEAN_JUNK'));
  /* 锁的是：R25-10 空目录扫描/垃圾扫描不跟随 junction（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
  assert.ok((junk.match(/isSymbolicLink\(\)/g) || []).length >= 2,
    '垃圾扫描的安装包/缓存两支至少有一支没跳过链接');
  const clean = code.slice(code.indexOf('CH.FS.CLEAN_JUNK'), code.indexOf('/* hash / encrypt'));
  /* 锁的是：R25-10 空目录扫描/垃圾扫描不跟随 junction（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
  assert.ok(/if \(lst\.isSymbolicLink\(\)\)/.test(clean), 'clean-junk 没有先 lstat 看穿链接');
  assert.ok(/readdir\(abs\)/.test(clean) && clean.indexOf('lstat') < clean.indexOf('readdir(abs)'),
    'clean-junk 可能在 lstat 之前就跟随链接 readdir');
});

t('R25-11 rename 在 resolve 之前拒绝盘符相对路径', () => {
  const code = readSrc('ipc/fs-ops.js');
  const seg = code.slice(code.indexOf('CH.FS.RENAME'), code.indexOf('CH.FS.DELETE'));
  /* 锁的是：R25-11 rename 在 resolve 之前拒绝盘符相对路径（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
  assert.ok(/isDriveRelativePath\(raw\.trim\(\)\)/.test(seg), 'rename 没有检查原始盘符相对路径');
  assert.ok(seg.indexOf('isDriveRelativePath') < seg.indexOf('path.resolve(from)'),
    '盘符相对检查发生在 path.resolve 之后，已失去意义');
});

t('R25-12 合并空文件清单时不跳过大小一致性校验', () => {
  const code = readSrc('ipc/fs-ops.js');
  /* 锁的是：R25-12 合并空文件清单时不跳过大小一致性校验（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
  assert.ok(/if \(mergedBytes !== declSize\)/.test(code), 'declSize=0 时仍会跳过合并大小校验');
});

t('R25-13 walkDir 的 maxDepth 先转有限非负整数', () => {
  const code = readSrc('ipc/fs-ops.js');
  const seg = code.slice(code.indexOf('async function walkDir'), code.indexOf('/* disk/tree analysis job'));
  /* 锁的是：R25-13 walkDir 的 maxDepth 先转有限非负整数（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
  assert.ok(/Number\.isFinite\(maxDepthRaw\)/.test(seg), 'maxDepth 非数值时会退化成无限深度');
});

t('R25-14 音频剪辑/截帧/录制/转换的 ffmpeg 数值参数先归一', () => {
  const media = readSrc('ipc/media-ffmpeg.js');
  for (const needle of [
    'const ssNum = (ss == null',
    'const fadeInNum = (fadeIn == null',
    'const widthRaw = (width == null',
    'const everyRaw = (every == null',
    'const countRaw = (count == null',
    'const fpsNum = (fps == null',
    'const camScaleNum = (camScale == null',
    'const gifWidthRaw = (opts.gifWidth == null',
  ]) {
  /* 锁的是：R25-14 音频剪辑/截帧/录制/转换的 ffmpeg 数值参数先归一（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
    assert.ok(media.includes(needle), '缺少数值归一：' + needle);
  }
  assert.ok(!/scale=\$\{opts\.gifWidth \|\| 480\}/.test(media), 'gif 宽度仍直接拼未校验值');
});

t('R25-15 TTS 导出在 mkdir/合成之前过覆盖闸门', () => {
  const code = readMain();
  const start = code.indexOf('CH.TTS.WAV');
  const seg = code.slice(start, start + 900);
  const guardAt = seg.indexOf('pathGuard.checkOverwritable(out)');
  const mkdirAt = seg.indexOf('fsp.mkdir(path.dirname(tmp)');
  /* 锁的是：R25-15 TTS 导出在 mkdir/合成之前过覆盖闸门（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
  assert.ok(guardAt >= 0 && mkdirAt > guardAt, 'TTS.WAV 仍在写临时文件之后才检查目标位置');
});

t('R25-16 store 反序列化去原型键，主题值夹到合法枚举', () => {
  const code = readMain();
  /* 锁的是：R25-16 store 反序列化去原型键，主题值夹到合法枚举（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
  assert.ok(/k === '__proto__' \|\| k === 'constructor' \|\| k === 'prototype'/.test(code),
    'loadStore 没有过滤原型污染键');
  const setTheme = code.slice(code.indexOf('CH.APP.SET_THEME'), code.indexOf('CH.APP.SET_AUTOSTART'));
  /* 锁的是：R25-16 store 反序列化去原型键，主题值夹到合法枚举（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
  assert.ok(/mode === 'light' \|\| mode === 'dark' \|\| mode === 'system'/.test(setTheme),
    'APP.SET_THEME 没有夹取非法值');
  const boot = code.slice(code.indexOf('const bootTheme'), code.indexOf('createSplash();'));
  /* 锁的是：R25-16 store 反序列化去原型键，主题值夹到合法枚举（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
  assert.ok(/bootTheme === 'light' \|\| bootTheme === 'dark' \|\| bootTheme === 'system'/.test(boot),
    '启动主题没有夹取非法值');
});

t('R25-17 env manifest 只认 <envs>/<id>/...，坏 applied 归一成数组', () => {
  const code = readSrc('ipc/env-manager.js');
  /* 锁的是：R25-17 env manifest 只认 <envs>/<id>/...，坏 applied 归一成数组（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
  assert.ok(/function isSafeEnvDir\(dir, id\)/.test(code), 'isSafeEnvDir 没有绑定运行时 id');
  assert.ok(/rel\.split\(path\.sep\)\[0\] === id/.test(code), 'manifest 可指向 envs/downloads 或 staging');
  assert.ok(/ids: Array\.isArray\(a\.ids\)/.test(code), 'envApplied.ids 坏值时没有归一');
});

t('R25-18 UI：窄窗下设置页侧栏改为横向，内容区减小留白', () => {
  const css = readSrc('css/app.css', { raw: true });
  /* 锁的是：R25-18 UI：窄窗下设置页侧栏改为横向，内容区减小留白（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
  assert.ok(/@media \(max-width: 760px\)/.test(css), '缺少设置页窄窗断点');
  assert.ok(/\.settings-wrap \{ flex-direction: column;/.test(css), '窄窗设置页仍强制左右两栏');
  assert.ok(/\.settings-nav \{[\s\S]{0,200}overflow-x: auto;/.test(css), '窄窗侧栏没有横向滚动');
  /* 锁的是：R25-18 UI：窄窗下设置页侧栏改为横向，内容区减小留白（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
  assert.ok(/@media \(max-width: 680px\)/.test(css), '缺少工具窗内容留白断点');
});

t('R25-19 解压最终复查不容忍根目录缺失，轮询阶段才允许', async () => {
  const { checkOutput } = require('../lib/archive-process');
  const path = require('path');
  const os = require('os');
  const missing = path.join(os.tmpdir(), 'hehe-r25-missing-' + process.pid + '-' + Date.now());
  await assert.rejects(checkOutput(missing), /ENOENT/, '最终复查把根目录缺失当成空目录成功');
  const r = await checkOutput(missing, {}, { allowMissingRoot: true });
  /* 锁的是：R25-19 解压最终复查不容忍根目录缺失，轮询阶段才允许（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
  assert.deepStrictEqual(r, { bytes: 0, entries: 0 }, '轮询阶段应容忍解压器尚未创建根目录');
});

t('R25-20 空目录扫描不把用户选中的扫描根列进待删清单', () => {
  const code = readSrc('ipc/fs-ops.js');
  const seg = code.slice(code.indexOf('CH.FS.SCAN_EMPTY_DIRS'), code.indexOf('CH.FS.DELETE_EMPTY'));
  /* 锁的是：R25-20 空目录扫描不把用户选中的扫描根列进待删清单（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
  assert.ok(/!isScanRoot\(dir\)/.test(seg), '扫描根自身仍会被列为可删空目录');
  const pushes = seg.match(/empty\.push/g) || [];
  assert.strictEqual(pushes.length, 2, '空目录入列分支数量变化，请确认根目录排除仍然生效');
});

t('R25-21 窄窗搜索下拉框用 max() 居左，560px 以下不会左侧越界', () => {
  const css = readSrc('css/app.css', { raw: true });
  const seg = css.slice(css.indexOf('.titlebar .search-dropdown'), css.indexOf('.search-dropdown.show'));
  /* 锁的是：R25-21 窄窗搜索下拉框用 max() 居左，560px 以下不会左侧越界（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
  assert.ok(/left:\s*max\(20px,\s*calc\(50%\s*-\s*280px\)\)/.test(seg), '搜索下拉仍用固定负外边距');
  assert.ok(/width:\s*min\(560px,\s*calc\(100vw\s*-\s*40px\)\)/.test(seg), '搜索下拉宽度没有随视口收缩');
  assert.ok(!/margin-left:\s*-280px/.test(seg), '固定 -280px 外边距仍在');
});

t('R25-22 局域网 IP 解析拒绝空段，查重模式/HTTP 读取有上限', () => {
  const LAN = require('../lib/lan-scan');
  /* 锁的是：R25-22 局域网 IP 解析拒绝空段，查重模式/HTTP 读取有上限（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
  assert.strictEqual(LAN.subnetOf('1.2.3.'), null, '空段被 Number("") 当成 0');
  assert.strictEqual(LAN.isPrivateIp('10..1.1'), false, '空段被当成私有地址');
  const fsOps = readSrc('ipc/fs-ops.js');
  /* 锁的是：R25-22 局域网 IP 解析拒绝空段，查重模式/HTTP 读取有上限（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
  assert.ok(/if \(!\[\'content\', \'name\', \'size\'\].includes\(mode\)\)/.test(fsOps), '未知查重模式仍被当成按体积');
  const net = readSrc('ipc/net-lan.js');
  assert.ok(/const HTTP_MAX_BYTES = 64 \* 1024 \* 1024/.test(net), 'HTTP 探测没有响应体积上限');
  /* 锁的是：R25-22 局域网 IP 解析拒绝空段，查重模式/HTTP 读取有上限（该入口未导出/需真实环境，行为断言无法直接注入，详见 docs/review-round25.md）。 */
  assert.ok(/readHttpCapped\(r, HTTP_MAX_BYTES\)/.test(net), 'HTTP 探测没有走限流读取');
});

t('R25-23 媒体批处理先校验输出目录，再登记可取消任务', () => {
  const media = readSrc('ipc/media-ffmpeg.js');
  for (const marker of ['CH.TARGET.COMPRESS_AV', 'CH.FFMPEG.CONVERT', 'CH.FFMPEG.PRESS', 'CH.FFMPEG.DOWNLOAD']) {
    const seg = media.slice(media.indexOf(marker), media.indexOf(marker) + 2400);
    const guardAt = seg.indexOf('assertOutDir') >= 0 ? seg.indexOf('assertOutDir') : seg.indexOf('fsp.mkdir');
    const jobsAt = seg.indexOf('jobs.set');
    /* 锁的是：outDir 非法时 assertOutDir/mkdir 抛错，若 jobs.set 已执行，
     * 任务表里会留下永远无法结束的幽灵任务。 */
    assert.ok(guardAt >= 0 && jobsAt > guardAt, marker + ' 在校验输出目录之前就登记了任务');
  }
});

t('R25-24 更新包摘要与 PE 校验使用同一个文件句柄', () => {
  const code = readSrc('lib/update-file.js');
  /* 锁的是：先按路径校验 PE、再按路径 createReadStream 哈希，中间可被替换；
   * 旧 Release 没有 assetSha256 时，校验的和实际替换的可能不是同一份文件。 */
  assert.ok(!/createReadStream\(file\)/.test(code), '更新包仍在关闭句柄后按路径重新打开哈希');
  assert.ok(/handle\.read\(chunk/.test(code), '没有在同一个句柄上分块计算摘要');
});

t('R25-25 PDF 导出/静态服务根目录的写读闸门', () => {
  const code = readMain();
  const pdf = code.slice(code.indexOf('CH.NOTES.PDF'), code.indexOf('CH.CLIP.SAVE_IMAGE'));
  /* 锁的是：notes:pdf 可绕过保存对话框直接传 outPath 覆盖任意文件。 */
  assert.ok(/checkOverwritable\(outFile\)/.test(pdf) && /!fromDialog && fs\.existsSync\(outFile\)/.test(pdf),
    'notes:pdf 仍可绕过对话框覆盖已有文件');
  const server = code.slice(code.indexOf('CH.SERVER.START'), code.indexOf('CH.SERVER.STOP'));
  /* 锁的是：站点根为 D:\\ 时 lr 以分隔符结尾，拼 lr+sep 会变成 D:\\\\，
   * 根下所有文件都被误判为越界。 */
  assert.ok(/lr\.endsWith\(path\.sep\) \? lr : lr \+ path\.sep/.test(server),
    '静态服务没有处理根目录尾随分隔符');
});

t('R25-26 一次性定时拒绝未知动作，临时清扫只删链接本身', () => {
  const code = readMain();
  const once = code.slice(code.indexOf('CH.SCHED.ONCE_ADD'), code.indexOf('CH.SCHED.ONCE_REMOVE'));
  /* 锁的是：IPC 传 shutdown/空值曾被静默映射成 sleep，到点把机器挂起。 */
  assert.ok(/p\.action !== 'lock' && p\.action !== 'sleep'/.test(once), '未知一次性动作仍会被当成睡眠');
  const sweep = code.slice(code.indexOf('async function sweepTempFiles'), code.indexOf('async function sweepPreviewTmp'));
  /* 锁的是：%TEMP% 下名为 hehe-* 的 junction 会被递归 rm，可能删到目标目录。 */
  assert.ok(/lst\.isSymbolicLink\(\)/.test(sweep), '临时清扫没有先 lstat 跳过链接');
});

done();
