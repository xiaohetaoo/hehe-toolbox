'use strict';
const { t, done } = require('./lib/harness');
/* 第五轮审查：破坏性 bug 的回归测试。
 *
 * 本轮的核心是「杜绝破坏性 bug」——用户数据被毁掉比功能失效严重得多。
 * 每个用例都对应一个已确认的真实 bug。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const guard = require('../lib/path-guard');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* 取 main.js 中某个 handle 块的正文。
 *
 * 【要认两种注册形态】任务 6 把两个域的通道名换成了常量（见 lib/channels.js），
 * 所以 handle 可能是 handle('link:remove', ...) 也可能是
 * handle(dirMoveCh.ACL_LINKS.LINK_REMOVE, ...)。后者用表反查后再试。 */
function handlerBody(src, channel) {
  let start = src.indexOf("handle('" + channel + "'");
  if (start < 0) {
    let expr = null;
    try {
      const table = require('../lib/channels').flatten();
      for (const k of Object.keys(table)) if (table[k] === channel) { expr = 'dirMoveCh.' + k; break; }
    } catch (e) { /* 表不可用时保持字面量行为 */ }
    if (expr) start = src.indexOf('handle(' + expr + ',');
  }
  assert.ok(start > 0, '找不到 handler: ' + channel);
  const end = src.indexOf('\n});', start);
  return src.slice(start, end);
}
/* 取升级脚本（const ps = [ ... ].join('\r\n');）的正文 */
function updateScriptBody(src) {
  const start = src.indexOf('const ps = [');
  assert.ok(start > 0, '找不到升级脚本');
  const end = src.indexOf("].join('", start);
  assert.ok(end > start, '找不到升级脚本结尾');
  return src.slice(start, end);
}

/* ================= P0：fs:delete 无边界 ================= */
t('P0 fs:delete 有路径闸门', () => {
  const fn = handlerBody(read('main.js'), 'fs:delete');
  assert.ok(fn.includes('pathGuard.checkDeletable'), '没有调用删除闸门');
  assert.ok(fn.includes('pathGuard.err'), '闸门拒绝时没有返回结构化错误');
});
t('P0 fs:delete 不再是裸的 fsp.rm', () => {
  const fn = handlerBody(read('main.js'), 'fs:delete');
  assert.ok(!/handle\('fs:delete'.*fsp\.rm\(p, \{ recursive: !!recursive, force: true \}\);/.test(fn),
    '仍是零校验的裸调用');
});

/* ================= P0：写文件覆盖 + 半截文件 ================= */
t('P0 fs:write-text / fs:write-file-b64 走原子写', () => {
  const s = read('main.js');
  assert.ok(s.includes('async function writeFileAtomic'), '没有原子写辅助函数');
  const fn = handlerBody(s, 'fs:write-text');
  assert.ok(fn.includes('writeFileAtomic'), 'fs:write-text 没用原子写');
  const fn2 = handlerBody(s, 'fs:write-file-b64');
  assert.ok(fn2.includes('writeFileAtomic'), 'fs:write-file-b64 没用原子写');
});
t('P0 原子写失败会清理临时文件', () => {
  const s = read('main.js');
  const fn = s.match(/async function writeFileAtomic[\s\S]*?\n\}/)[0];
  assert.ok(fn.includes("rm(tmp, { force: true })"), '失败时没清理临时文件');
  assert.ok(fn.includes('rename(tmp, dest)'), '没有用 rename 做原子提交');
});
t('P0 原子写有覆盖保护', () => {
  const s = read('main.js');
  const fn = s.match(/async function writeFileAtomic[\s\S]*?\n\}/)[0];
  assert.ok(fn.includes('checkOverwritable'), '没有检查是否可覆盖');
});

/* ================= P0：%TEMP% 清理越界 ================= */
t('P0 fs:scan-junk 的临时项只扫本应用产物', () => {
  const fn = handlerBody(read('main.js'), 'fs:scan-junk');
  assert.ok(fn.includes('ownOnly'), '没有 ownOnly 标记');
  assert.ok(fn.includes('isOwnTempName'), '没有用白名单过滤');
  // 关键：temp 这一项不能把整个 os.tmpdir() 作为 target
  const tempLine = fn.match(/\{ id: 'temp'[^\n]*/);
  assert.ok(tempLine, '找不到 temp 候选');
  assert.ok(tempLine[0].includes('ownOnly: true'), 'temp 项未标记 ownOnly');
  assert.ok(!/targets: \[c\.path\]/.test(fn.match(/ownOnly[\s\S]*?continue;/)[0] || ''), 'ownOnly 分支仍用了整个目录');
});
t('P0 fs:clean-junk 拒绝清理 %TEMP% 里的非本应用产物', () => {
  const fn = handlerBody(read('main.js'), 'fs:clean-junk');
  assert.ok(fn.includes('tmpRoot'), '没有识别 %TEMP% 根');
  assert.ok(fn.includes('isOwnTempName'), '没有用白名单校验');
  assert.ok(fn.includes('checkDeletable'), '没有系统关键目录闸门');
});
t('P0 临时产物白名单覆盖所有本应用目录', () => {
  /* 【改成行为断言】原来的写法是从 main.js 里正则抠出
   * `const OWN_TEMP_PATTERNS = [...]` 那一整段，再检查里面出现了哪些前缀字符串。
   * 任务 10 把白名单搬进 lib/temp-names.js（生成函数与白名单放在一处、
   * 由生成函数反推正则）之后，main.js 里已经没有那个数组 ——
   * 断言立刻炸（Cannot read properties of null）。
   * 而「白名单覆盖所有产物」本来就能**直接行为验证**：
   * 用每个生成函数造个真实名字，看白名单认不认。
   * 这比"源码里出现过某字符串"强得多 —— 那个字符串完全可能只出现在注释里，
   * 而对应的正则根本不存在（.hehe-7zx- 那次事故就是这样）。 */
  const T = require('../lib/temp-names');
  const pathMod = require('path');
  const NOW = 1700000000000, HEX = 'abc123';
  const mustHit = [
    T.snipTmp({ now: NOW, hex: HEX }),
    T.ffmpegZip({ now: NOW }),
    T.recSegDir({ now: NOW }),
    T.tgtTmpDir({ now: NOW, hex: HEX }),
    T.uniqTmpDir({ now: NOW, hex: HEX }),
    T.sevenStagingDir('D:/out', { now: NOW, hex: HEX }),
    T.writeTmp('D:/a/x.txt', 'tag1'),
    T.writeBak('D:/a/x.txt', 'tag1'),
    T.cryptTmp('D:/a/out.enc', { now: NOW, hex: HEX }),
    T.updateLogName('20260101-010101'),
    T.rollbackLogName('20260101-010101'),
  ];
  const miss = mustHit.map((x) => pathMod.basename(x)).filter((n) => !T.isOwnTempName(n));
  assert.deepStrictEqual(miss, [],
    '这些本应用产物匹配不上清理白名单（崩溃后会永久残留）：' + miss.join(', '));
  /* 另外确认 main.js 确实把判定委托给了模块（否则两边又会分家） */
  assert.ok(/isOwnTempName\(name\)\s*\{\s*return tempNames\.isOwnTempName/.test(read('main.js')),
    'main.js 没有把白名单判定委托给 lib/temp-names.js');
});

/* ================= P1：升级脚本三个破坏点 ================= */
t('P1 升级脚本备份不覆盖历史版本', () => {
  const fn = updateScriptBody(read('main.js'));
  assert.ok(fn.includes('$stamp'), '没有带时间戳的备份');
  assert.ok(/Destination \(\$backup \+ "\." \+ \$stamp\)/.test(fn), '历史备份没保留');
});
t('P1 升级脚本替换后校验大小', () => {
  const fn = updateScriptBody(read('main.js'));
  assert.ok(fn.includes('$srcLen'), '没有记录源大小');
  assert.ok(fn.includes('$dstLen'), '没有记录目标大小');
  assert.ok(fn.includes('大小不符'), '没有大小校验');
});
t('P1 升级脚本启动失败时保留下载包', () => {
  const fn = updateScriptBody(read('main.js'));
  assert.ok(fn.includes('$launched'), '没有记录启动成功与否');
  // Remove-Item newExe 必须在 if (-not $launched) 这道闸门之后
  const rmIdx = fn.indexOf('Remove-Item -LiteralPath $newExe');
  const guardIdx = fn.indexOf('if (-not $launched)');
  assert.ok(guardIdx > 0 && rmIdx > guardIdx, '删除下载包没有被启动成功条件保护');
});

/* ================= P1：hosts 写入 ================= */
t('P1 hosts:write 备份失败时中止写入', () => {
  const fn = handlerBody(read('main.js'), 'hosts:write');
  assert.ok(fn.includes('backedUp'), '没有记录备份是否成功');
  assert.ok(!/catch \(err\) \{ \/\* 备份失败不阻断/.test(fn), '备份失败仍然继续写入');
});
t('P1 hosts:write 不退化成非原子覆盖写', () => {
  const fn = handlerBody(read('main.js'), 'hosts:write');
  assert.ok(!/fsp\.writeFile\(HOSTS_PATH, content/.test(fn), '仍有直接写系统 hosts 的路径');
  assert.ok(fn.includes('rename(tmp, HOSTS_PATH)'), '没有用 rename 原子替换');
});

/* ================= P1：录制降级 ================= */
t('P1 rec:stop 降级时保留分段目录', () => {
  const fn = handlerBody(read('main.js'), 'rec:stop');
  const rmIdx = fn.indexOf('fsp.rm(recSegDir');
  const guardIdx = fn.indexOf('if (!degraded)');
  assert.ok(guardIdx > 0, '没有按 degraded 判断是否清理');
  assert.ok(rmIdx > guardIdx, '分段目录无条件被删');
});
t('P1 渲染层会显示 degraded', () => {
  const s = read('js/tools/media.js');
  assert.ok(s.includes('r.degraded'), '渲染层忽略了 degraded');
  assert.ok(s.includes('escapeHtml(r.degraded)'), 'degraded 没有转义就插入 HTML');
});

/* ================= P1：图片自我覆盖 ================= */
t('P1 图片压缩输出一律取唯一名（既不盖原图也不盖已有输出）', () => {
  const s = read('js/tools/media.js');
  assert.ok(s.includes('function samePath'), '缺少 samePath 辅助函数（其它地方仍在用）');
  // 现在的做法比 samePath 更严：输出路径无条件过 unique-path，
  // 因此既防「输出==输入」，也防「输出与目录里已有文件同名」。
  assert.ok(/const finalPath = await invoke\('fs:unique-path', outPath\)/.test(s),
    '压缩输出没有无条件唯一化');
});
t('P1 水印输出一律取唯一名', () => {
  const s = read('js/tools/media.js');
  assert.ok(/const outPath = await invoke\('fs:unique-path', outDir\.replace/.test(s),
    '水印输出没有无条件唯一化');
  assert.ok(s.includes('_wm.'), '没有水印命名逻辑');
  assert.ok(s.includes('hasExt'), '没有区分有无扩展名（无扩展名时替换逻辑会失效）');
});

/* ================= P1：proc:kill 自我保护 ================= */
t('P1 proc:kill 不能杀自己', () => {
  const fn = handlerBody(read('main.js'), 'proc:kill');
  assert.ok(fn.includes('process.pid'), '没有自我保护');
  assert.ok(/n === process\.pid/.test(fn), '没有比较自身 pid');
  assert.ok(fn.includes('Number.isInteger'), '没有校验 pid 合法性');
});

/* ================= P1：merge-parts 路径穿越与覆盖 ================= */
t('P1 fs:merge-parts 限制清单里的 name 在目录内', () => {
  const fn = handlerBody(read('main.js'), 'fs:merge-parts');
  assert.ok(fn.includes('resolveInside'), '没有限制 man.name 的路径');
});
t('P1 fs:merge-parts 指定输出路径时不覆盖已有文件', () => {
  const fn = handlerBody(read('main.js'), 'fs:merge-parts');
  assert.ok(fn.includes('checkOverwritable'), '没有覆盖保护');
  assert.ok(fn.includes('fs.existsSync(finalOut)'), '没有检查目标是否已存在');
});

/* ================= P1：zip 解压不覆盖 ================= */
t('P1 zip:extract 同名不覆盖', () => {
  const fn = handlerBody(read('main.js'), 'zip:extract');
  assert.ok(fn.includes('uniqueTarget'), '解压仍会覆盖同名文件');
});
t('P1 uniqueTarget 自身有穿越防护', () => {
  const s = read('main.js');
  const fn = s.match(/async function uniqueTarget[\s\S]*?\n\}/)[0];
  assert.ok(fn.includes('resolveInside'), 'uniqueTarget 没有路径校验');
});

/* ================= P2：门禁一致性 ================= */
t('P2 path-guard 模块存在且导出完整', () => {
  const g = require('../lib/path-guard');
  for (const k of ['checkFileName', 'resolveInside', 'checkDeletable', 'checkOverwritable', 'isCriticalPath']) {
    assert.strictEqual(typeof g[k], 'function', '缺少导出: ' + k);
  }
});
t('P2 path-guard 已进构建配置', () => {
  const pkg = require('../package.json');
  assert.ok(pkg.build.files.includes('lib/**/*'), 'lib 未进构建');
});
t('P2 path-guard 测试已接入 npm test', () => {
  /* 【这条断言的本意是「跑 npm test 时会连 test-path-guard.js 一起跑」】
   * 原来只读 pkg.scripts.test 这一个字符串 —— 等于把断言绑死在
   * 「test 是一条长长的 && 链」这个实现细节上。
   * 任务 8 把 test 拆成 `npm run test:unit && npm run test:ui` 之后，
   * 这个字符串里自然不再出现具体脚本名，断言就误报了（功能完全正常：
   * test-path-guard.js 在 test:unit 里）。
   * 现在按**语义**判：把 test 展开成实际会执行的脚本清单（跟随一层
   * npm run 引用），再看目标脚本在不在里面。无论 test 怎么组织
   * （单链 / 两条 / 将来再拆三条）都成立。 */
  const pkg = require('../package.json');
  const seen = new Set();
  const collect = (scriptName, depth) => {
    if (depth > 3) return;
    const body = pkg.scripts[scriptName];
    if (typeof body !== 'string') return;
    for (const piece of body.split('&&').map((s) => s.trim()).filter(Boolean)) {
      const m = piece.match(/^npm\s+run\s+([^\s]+)$/);
      if (m) { collect(m[1], depth + 1); continue; }
      seen.add(piece);
    }
  };
  collect('test', 0);
  assert.ok([...seen].some((s) => s.includes('test-path-guard.js')),
    '未接入 npm test（展开 test 后实际执行的脚本里没有 test-path-guard.js）');
});

/* ================= 第二轮：子代理审查发现的破坏性 bug ================= */

/* P0-1 下载器文件名路径穿越 */
t('P0 下载文件名不从 URL 直接取（防 %2F..%2F 穿越）', () => {
  const s = read('js/tools/net-tools.js');
  assert.ok(s.includes('safeNameFromUrl'), '没有安全文件名函数');
  // 旧的裸 decodeURIComponent 拼接必须消失
  const code = s.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/decodeURIComponent\(url\.split\('\?'\)\[0\]\.split\('\/'\)\.pop\(\)/.test(code),
    '仍在直接用 URL 末段当文件名');
  const fn = s.match(/function safeNameFromUrl[\s\S]*?\n  \}/)[0];
  assert.ok(fn.includes('split(/[\\\\/]/)'), '没有取 basename');
  assert.ok(fn.includes('BAD_NAME_BASE'), '没有挡 Windows 设备名');
});

/* P0-2 Office 转换覆盖同基名文件 */
t('P0 office:convert COM 分支用 uniqueTarget', () => {
  const s = read('main.js');
  const fn = s.match(/\/\/ Office COM 引擎[\s\S]*?\n\}\);/);
  const body = fn ? fn[0] : s.slice(s.indexOf("results.push({ input: f, out: null, ok: false, err: `COM 引擎不支持"), s.indexOf('return { engine: \'Office COM\''));
  assert.ok(s.includes('uniqueTarget(outDir, base + \'.\' + target)'), 'COM 分支没有唯一化输出名');
});
t('P0 office:convert LibreOffice 分支先转临时目录再挪', () => {
  /* 【改成行为断言】原来检查的是 `if (soffice) {` 之后 1600 字符里有没有
   * 字符串 'hehe-uniq-' —— 那是把断言绑在「临时目录叫什么」这个实现细节上。
   * 任务 10 把前缀收进 lib/temp-names.js 之后，这里涨到 1600 字符以外就失配了
   * （而行为完全正确）。
   * 真正要守的语义是：LibreOffice 分支必须「先转临时目录、再挪到唯一目标名」，
   * 不能直接往最终路径写（否则失败会留下半个文件，且可能覆盖已有文件）。
   * 所以这里断言两件事：
   *   1) 该分支调用了 tempNames.uniqTmpDir（临时中转目录的来源）；
   *   2) 该分支用了 uniqueTarget（输出名唯一化）。 */
  const s = read('main.js');
  const i = s.indexOf('if (soffice) {');
  assert.ok(i > 0, '找不到 LibreOffice 分支');
  /* 【窗口要给足余量】这里不是在测"代码有多紧凑"，而是在测"分支里有没有那几个动作"。
   * 第一次取 2500 字符，而提交动作（moveFile）落在 2526 —— 差 26 个字符就误报。
   * 这种"按字符数截窗口"的断言本身就是脆弱的：实现多写一行注释就会失配。
   * 所以给到 4000，并且下面只断言**语义动作存在**（临时目录、唯一化、提交），
   * 不断言它们的具体顺序或版面。 */
  const seg = s.slice(i, i + 4000);
  assert.ok(/tempNames\.uniqTmpDir\(/.test(seg),
    '没有一点用临时目录中转（应调用 tempNames.uniqTmpDir）');
  assert.ok(seg.includes('uniqueTarget') || seg.includes('fsOps.uniquePath'),
    '没有唯一化输出名');
  /* 提交动作可能是 moveFile（跨盘时裸 rename 会 EXDEV）而不是 fsp.rename，
   * 所以两种都接受 —— 断言的是「有个把临时产物挪到最终位置的动作」。 */
  assert.ok(seg.includes('moveFile(') || seg.includes('fsp.rename('), '没有「转完再挪」的提交动作');
});

/* P0-3 PDF 拆分/转图片固定命名 */
t('P0 PDF 拆分输出目录带时间戳', () => {
  const s = read('js/tools/office.js');
  assert.ok(/-split-' \+ stamp/.test(s), '拆分目录没有时间戳');
  assert.ok(s.includes("'fs:unique-path', `${dir}/part-"), '分片没有唯一化');
});
t('P0 PDF 转图片输出目录带时间戳', () => {
  const s = read('js/tools/office.js');
  assert.ok(/-images-' \+ stamp/.test(s), '图片目录没有时间戳');
  assert.ok(s.includes("'fs:unique-path', `${outDir}/page-"), '页面图片没有唯一化');
});

/* P0 writeFileAtomic 不得先删原文件 */
t('P0 writeFileAtomic 不用「先 rm 后 rename」', () => {
  const s = read('main.js');
  const fn = s.match(/async function writeFileAtomic[\s\S]*?\n\}/)[0];
  assert.ok(!/fsp\.rm\(dest, \{ force: true \}\)\.catch\(\(\) => \{\}\);\s*\n\s*await fsp\.rename\(tmp, dest\)/.test(fn),
    '仍是先删目标再改名（会丢原文件）');
  assert.ok(fn.includes('.hehe-bak-'), '没有备份中转');
  assert.ok(/rename\(bak, dest\)/.test(fn), '失败时没有把备份搬回去');
});

/* P1-4 笔记文件名过滤 */
t('P1 笔记文件名挡住设备名与尾随点', () => {
  const s = read('js/tools/text-tools.js');
  assert.ok(s.includes('safeNoteName'), '没有安全文件名函数');
  const fn = s.match(/function safeNoteName[\s\S]*?\n      \}/)[0];
  assert.ok(fn.includes('DEVICE_BASE'), '没有挡 Windows 设备名');
  assert.ok(/\[\. \]\+\$/.test(fn), '没有去尾随点/空格');
  assert.ok(fn.includes('replace(/^\\.+/, \'\')'), '没有去首部点');
});

/* P1-5 批量改后缀 */
t('P1 批量改后缀拒绝非法后缀字符', () => {
  const s = read('js/tools/file-tools.js');
  assert.ok(/新后缀不能包含/.test(s), '没有校验新后缀');
});
t('P1 批量改后缀正确处理无扩展名文件', () => {
  const s = read('js/tools/file-tools.js');
  assert.ok(s.includes('lastIndexOf(\'.\')'), '没有正确判断扩展名');
  assert.ok(s.includes('hasExt'), '没有区分有无扩展名');
  assert.ok(!/item\.path\.slice\(0, item\.path\.length - ext\.length\) \+ to/.test(s), '仍是旧拼接写法');
});

/* P1-6 批量操作失败可见
 *
 * 【这一组断言原来锁的是**缺陷本身**，必须说明清楚】
 * 原来写成：
 *   assert.ok(/alertBox\({[\s\S]{0,200}部分文件未能修改/.test(s), '没有弹失败明细');
 * 它要求源码里出现「alertBox 紧跟一个左花括号」——而 alertBox 的签名是
 * alertBox(message, title)，传配置对象进去会被 h() 当普通对象丢掉，
 * 弹出来是个正文空白的框。也就是说这条断言当初把一个**错误调用形态**
 * 当成了修复标志；等真正改对（alertBox(文本, 标题)）之后，它反而红了，
 * 而且因为 package.json 用 && 串联，它一红后面 60 多个脚本全不执行。
 *
 * 【任务 2 把这条彻底改成了行为断言】
 * 明细拼接搬进了 lib/fail-text.js，主代码与测试 require 的是**同一个函数**。
 * 这里直接调它断言返回值内容（含文件名、含原因、含截断提示），
 * 不再从 file-tools.js 里"按字面量抠出函数体再 new Function"——
 * 那种做法虽然比正则匹配源码强，仍然是「按版面取实现」：
 * 只要有人改个函数名（比如 buildFailText → failText），它就报「找不到」。
 *
 * 剩下一条源码断言只锁**结构事实**：两处都调用了 alertBox 且第一个实参
 * 是明细文本、第二个是标题。这条没法用行为断言替代，因为 alertBox 依赖
 * 真实 DOM 与 ui 层（测试环境不加载 js/ui.js）。
 */

/* 剥注释统一走 lib/src-scan.js（三个测试脚本共用一份实现，见该文件里的说明）。 */
const { stripComments } = require(path.join(ROOT, 'lib', 'src-scan'));
const { buildFailText } = require('../lib/fail-text');

t('P1 批量改后缀失败时列出明细', () => {
  const s = read('js/tools/file-tools.js');
  assert.ok(s.includes('failures.push'), '没有收集失败明细');
  const failures = [
    { from: 'D:/a/one.txt', to: 'D:/a/one.md', err: '被占用' },
    { from: 'D:/a/two.txt', to: 'D:/a/two.md', err: '拒绝访问' },
  ];
  const text = buildFailText(3, failures);
  // 关键：文件名、目标名、原因都必须真的出现在文本里（不是"调用大概对了"）
  assert.ok(text.includes('one.txt'), '明细里没有源文件名');
  assert.ok(text.includes('one.md'), '明细里没有目标名');
  assert.ok(text.includes('被占用'), '明细里没有失败原因');
  assert.ok(text.includes('拒绝访问'), '第二个失败项被吞掉了');
  assert.ok(text.includes('成功 3 个') && text.includes('失败 2 个'), '成功/失败计数不对：' + text.split('\n')[0]);
  // 反面对照：不能是空串或只有标题（空串正是"空白框"的表现）
  assert.ok(text.trim().length > 20, '明细文本过短，弹出来接近空白：' + JSON.stringify(text));
});

t('P1 批量重命名失败时列出明细', () => {
  const text = buildFailText(0, [{ from: 'D:/b/x.jpg', to: 'D:/b/x.png', err: '目标已存在' }]);
  assert.ok(text.includes('x.jpg') && text.includes('x.png') && text.includes('目标已存在'),
    '重命名明细缺少文件或原因');
  // 截断提示：20 条失败、默认只列 15 条，必须说明"还有 5 个未列出"
  const many = Array.from({ length: 20 }, (_, k) => ({ from: 'f' + k, to: 'g' + k, err: 'err' + k }));
  const big = buildFailText(1, many);
  assert.ok(big.includes('…还有 5 个未列出'), '超过 15 条时没说明剩余数量');
  assert.ok(!big.includes('err19'), '第 20 条不该被列出（上限 15）');
  assert.ok(big.includes('err14'), '第 15 条应该被列出（上限 15）');
});

t('P1 两处调用都用 alertBox(文本, 标题) 而不是配置对象', () => {
  /* 【先剥注释再断言】
   * 这条是反面断言（"源码里不许出现对象调用形态"），而**解释这个缺陷的
   * 注释本身**必然要写出那种形态（"原来这里写成 alertBox({ title, message })"）。
   * 不剥注释就会让"记录缺陷的文字"触发"禁止缺陷"的规则 —— 我第一次跑
   * 这条断言时正是被 file-tools.js 里那段说明注释卡住的。
   * 这与 test-i18n-coverage 里修的另一处是同一类问题：注释不是代码。
   * 剥注释的逻辑自测一版，避免"复刻一份"导致假绿（见下方断言）。 */
  const strip = stripComments;
  const raw = read('js/tools/file-tools.js');
  const s = strip(raw);
  // 反面：不许再出现 alertBox(…) 后紧跟对象字面量的调用形态
  assert.ok(!/alertBox\s*\(\s*\{/.test(s),
    '仍在用 alertBox({ title, message }) —— 对象会被 h() 丢掉，弹出空白框');
  // 正面：两处标题都作为第二个实参出现
  assert.ok(/alertBox\s*\(\s*buildFailText[\s\S]{0,80}?'部分文件未能重命名'/.test(s),
    '重命名那处没有把标题作为第二个实参');
  assert.ok(/alertBox\s*\(\s*buildFailText[\s\S]{0,80}?'部分文件未能修改'/.test(s),
    '改后缀那处没有把标题作为第二个实参');
});

/* P2-8 音频剪辑固定命名 */
t('P2 音频剪辑输出名唯一化', () => {
  const s = read('js/tools/media.js');
  assert.ok(/fs:unique-path', src\.replace\(\/\\\.\\w\+\$\/, '_cut\./.test(s), '音频剪辑没有唯一化');
});

/* P2-10 notes:pdf 原子写 */
t('P2 notes:pdf 用原子写', () => {
  const s = read('main.js');
  const i = s.indexOf("handle('notes:pdf'");
  const seg = s.slice(i, i + 1200);
  assert.ok(!/fs\.writeFileSync\(outFile/.test(seg), '仍是 writeFileSync 直写');
  assert.ok(seg.includes('writeFileAtomic'), '没有用原子写');
});

/* P2-11 GIF 残file */
t('P2 GIF 转码失败时清理残缺文件', () => {
  const s = read('main.js');
  const i = s.indexOf('let gifOut = null;');
  const seg = s.slice(i, i + 900);
  assert.ok(seg.includes('gifTarget'), '没有独立的 gif 目标变量');
  assert.ok(/rm\(gifTarget/.test(seg), '失败时没有删除残缺 gif');
});

/* P2 audio-cut 自我覆盖防护 */
t('P2 ffmpeg:audio-cut 拒绝输出等于输入', () => {
  const s = read('main.js');
  const i = s.indexOf("handle('ffmpeg:audio-cut'");
  const seg = s.slice(i, i + 700);
  assert.ok(seg.includes('输出文件不能与源文件相同'), '没有自我覆盖检查');
  assert.ok(seg.includes('checkOverwritable'), '没有覆盖闸门');
});

/* ================= 结构性检查：不允许重复注册 IPC 通道 ================= */
t('main.js 没有重复注册的 IPC 通道', () => {
  const s = read('main.js');
  const re = /handle\('([^']+)'/g;
  const seen = new Map();
  let m;
  while ((m = re.exec(s))) {
    const ch = m[1];
    const line = s.slice(0, m.index).split('\n').length;
    if (!seen.has(ch)) seen.set(ch, []);
    seen.get(ch).push(line);
  }
  const dups = [...seen.entries()].filter(([, v]) => v.length > 1);
  assert.deepStrictEqual(dups.map(([k, v]) => `${k}@${v.join(',')}`), [],
    '重复注册会让应用启动即报 "Attempted to register a second handler" 并卡死');
});

done();
