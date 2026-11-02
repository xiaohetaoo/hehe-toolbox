const { t, done, readMain } = require('./lib/harness');
/* 主进程源码：迁移来的 parsePsDate 用例要看 fmtBoot 的实现形态。 */
const mainSrc = readMain({ raw: true });
const stripComments = require('../lib/src-scan').stripComments;
/* P1-3 / P2-3 / P3-1 的回归测试（渲染层行为的静态校验 + 真实现行为）。
 *
 * 这三条都是「看起来在跑、其实结论是错的」类缺陷：
 *   P1-3 file-unlock 用 it.dir 判断目录，而字段叫 isDir —— 目录分支是死代码，
 *        「删不掉整个目录」得到的是「没有检测到占用」这个错误结论。
 *   P2-3 乱码修复文件模式只读 from/to，而文件分支给的是 encodings/label ——
 *        界面显示「? → ?」，真正有用的编码名一个字都没显示。
 *   P3-1 「检查能否无损转码」恒传 utf-8，这个按钮没有判断任何用户关心的事。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const srcScan = require('../lib/src-scan');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* 【任务 6 之后有两种写法】通道名换成常量后：
 *   · 渲染层：invoke(Channels.CHANNELS.ACL_LINKS.WHO_LOCKS_DIR, ...)
 *   · 主进程：handle(dirMoveCh.ACL_LINKS.WHO_LOCKS_DIR, ...)
 * 而迁移前是字面量 'file:who-locks-dir'。下面两个辅助两种都认，
 * 断言只关心「有没有调用/注册这个语义通道」，不关心写成什么形式。 */
function rendererUses(src, literal, expr) {
  return src.includes("invoke('" + literal + "'") || src.includes(expr);
}
function handlerBlock(mainSrc, literal, expr) {
  /* 任务 5 把这两个域搬到了 ipc/dir-acl-links.js，那里的常量别名是 CH，
   * 而调用方传进来的是 readMain()（main.js + ipc/ 拼接）。
   * 所以三种形态都要试：字面量 / dirMoveCh.<键> / CH.<键>。 */
  let i = mainSrc.indexOf("handle('" + literal + "'");
  if (i < 0) i = mainSrc.indexOf('handle(' + expr + ',');
  if (i < 0 && expr.startsWith('dirMoveCh.')) {
    i = mainSrc.indexOf('handle(CH.' + expr.slice('dirMoveCh.'.length) + ',');
  }
  if (i < 0) return null;
  const j = mainSrc.indexOf('\n});', i);
  return mainSrc.slice(i, j > i ? j : i + 3000);
}

function strip(s) {
  return String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
}

/* ---------- P1-3：文件占用解锁的目录分支 ---------- */
t('file-unlock 保留 isDir，不再把它 map 掉', () => {
  const src = strip(read('js/tools/file-unlock.js'));
  assert.ok(/isDir:\s*\(typeof x\.isDir === 'boolean'\)/.test(src),
    'onChange 里必须保留 isDir，否则类型信息丢失');
});

t('file-unlock 不再用不存在的 it.dir 判断', () => {
  const src = strip(read('js/tools/file-unlock.js'));
  assert.ok(!/it\.dir\b/.test(src),
    'fileList 的字段是 isDir 不是 dir，用 it.dir 恒为 undefined');
});

t('file-unlock 查询前会 await 确认类型（不靠 undefined 猜）', () => {
  const src = strip(read('js/tools/file-unlock.js'));
  assert.ok(/async function resolveTypes\(/.test(src), '应有查前确认类型的步骤');
  assert.ok(/await invoke\('fs:stat-multi'/.test(src), '应调用 fs:stat-multi 确认类型');
  /* 【断言的是「必须 await」，不是某个具体实参】
   * round-12 把 resolveTypes 改成只作用于**当轮快照**（resolveTypes(snapshot)）：
   * 原实现直接读 state.items，用户在 stat 返回前改选择时，补类型与发任务
   * 会落到两批不同对象上（目录被送进文件通道，Restart Manager 整批 ERR 5）。
   * 这里要守住的不变量自始至终是「发查询前必须等类型确认完」，与传什么无关。 */
  assert.ok(/await resolveTypes\([^)]*\)/.test(src), 'scan() 必须先 await 它');
  assert.ok(/it\.isDir[\s\S]{0,120}(invoke\('file:who-locks-dir'|WHO_LOCKS_DIR)/.test(src),
    '目录应走 file:who-locks-dir 通道');
});

t('file-unlock 的目录通道真的有调用方（不是死分支）', () => {
  const src = strip(read('js/tools/file-unlock.js'));
  assert.ok(rendererUses(src, 'file:who-locks-dir', 'ACL_LINKS.WHO_LOCKS_DIR'),
    'file:who-locks-dir 必须有调用方，否则删目录只能得到「没有占用」的错误结论');
});

/* ---------- P2-3：乱码修复文件模式的编码名 ---------- */
t('文件分支把候选补成 from/to 形状（保留 label/encodings）', () => {
  const main = strip(readMain({ raw: true }));
  const fn = main.match(/handle\('text:detect-encoding'[\s\S]*?\n\}\);/);
  assert.ok(fn, '找不到 text:detect-encoding');
  assert.ok(/from:\s*'原始字节'/.test(fn[0]), '文件模式应给出 from = 原始字节');
  assert.ok(/to:\s*c\.label/.test(fn[0]), '文件模式应把 label 映射到 to');
  assert.ok(/c\.encodings/.test(fn[0]), 'label 缺失时退到 encodings（原字段保留）');
});

t('渲染层优先读 to，退到 label/encodings —— 两种形状都能显示', () => {
  const src = strip(read('js/tools/mojibake-fix.js'));
  assert.ok(/function labelOf/.test(src) || /const labelOf/.test(src), '应有统一的 labelOf');
  assert.ok(/c\.to\s*\|\|\s*c\.label\s*\|\|\s*c\.encodings/.test(src) ||
            /to\s*\|\|\s*core\.label/.test(src) ||
            /row\.to\s*\|\|/.test(src) ||
            /c && \(c\.to \|\| c\.label \|\| c\.encodings\)/.test(src),
    'labelOf 应兼容 to / label / encodings 三种来源');
  assert.ok(!/\(row\.to \|\| '?'\)/.test(src), '候选表不该再直接读 row.to');
  assert.ok(!/\(best\.to \|\| '?'\)/.test(src), '最优结果不该再直接读 best.to');
});

/* ---------- P3-1：目标编码由用户选 ---------- */
t('「检查能否无损转码」不再把目标编码写死为 utf-8', () => {
  const src = strip(read('js/tools/mojibake-fix.js'));
  assert.ok(!/can-reencode', best\.text, 'utf-8'\)/.test(src),
    '目标编码仍写死 utf-8 —— 只要没有替换字符就必定回「可以转换」');
  assert.ok(/can-reencode', best\.text, encSel\.value\)/.test(src),
    '应把用户选的编码传进去');
});

t('目标编码至少提供 GBK 与 UTF-8 两项', () => {
  const src = strip(read('js/tools/mojibake-fix.js'));
  /* 【窗口必须精确落在选项数组上，不能是「can-reencode 往前 1200 字符」】
   * 原实现取 `src.slice(indexOf('can-reencode') - 1200, indexOf('can-reencode'))`。
   * 这个窗口确实覆盖了下拉框的选项构造，但**也覆盖了紧跟着的默认值表达式**：
   *   encSel.value = /utf-8/i.test(labelOf(best)) ? 'gbk' : 'utf-8';
   * 而断言写的是 `/gbk/.test(seg)` —— 只要窗口里出现过任意一个 'gbk' 就算通过。
   * 实测确认：把选项数组改成只剩 [['utf-8','UTF-8']]（GBK 选项彻底移除），
   * 这条断言仍然 PASS，因为默认值那一行的 'gbk' 还在。
   *
   * 现在改成锚定「选项数组」本身：找到 encSel 的 for...of 里的那个二维数组，
   * 再断言它含 'gbk' 与 'utf-8'。这样默认值那行的字面量不会干扰判定。 */
  const arrMatch = src.match(/for \(const \[v, t\] of \[([\s\S]*?)\]\) \{/);
  assert.ok(arrMatch, '找不到目标编码的选项数组（实现可能已改动，请同步更新这条断言）');
  const options = arrMatch[1];
  assert.ok(/\[\s*'gbk'/.test(options), '目标编码选项里没有 GBK（用户选不到，默认值那行的 gbk 不能顶替）');
  assert.ok(/\[\s*'utf-8'/.test(options), '目标编码选项里没有 UTF-8');
  assert.ok(/\[\s*'gb18030'/.test(options), '目标编码选项里没有 GB18030');
  assert.ok(/\[\s*'big5'/.test(options), '目标编码选项里没有 Big5');
});

/* ---------- 行为验证：text:can-reencode 对 GBK 的真实结论 ---------- */
t('GBK 不在 Node 原生编码器里 → 结论必须是「需要系统工具」', async () => {
  /* 【必须是真行为断言，不能断言测试自己写的常量】
   * 原实现是 `const NATIVE = ['utf-8','utf-16le','utf-16be'];` 定义在**测试文件里**，
   * 然后断言 `NATIVE.indexOf('gbk') === -1` —— 测的是测试自己的数组，
   * 与 main.js 的实现无关。实测确认：把 main.js 里那份 supported 列表
   * 改成含 'gbk'（于是 GBK 被误判成「可以转换」，而 Node 其实没有 GBK 编码器），
   * 这条断言仍然 PASS。
   *
   * 现在真的跑 main.js 里那段判据：把 text:can-reencode 的 handler 抽出来，
   * 注入桩后调用，断言它对 GBK 给出的 supported 是 false。 */
  const mainSrc = strip(readMain({ raw: true }));
  const start = mainSrc.indexOf("handle('text:can-reencode'");
  assert.ok(start > 0, '找不到 text:can-reencode');
  /* 【用括号配平取箭头函数，不能用 '\n});' 切】
   * handler 结尾是 `\n});` —— 但那个 `)` 属于外层的 handle(…)，不属于函数体。
   * 用 '\n});' 做右边界会把多余的 ')' 切进来，`(async …})` 直接语法错误。
   * 改用 lib/src-scan.js 的 scanBrace：从 async 之后的第一个 '{' 配平，
   * 它跳过注释/字符串/正则，不会被文案里的括号带偏。 */
  const asyncAt = mainSrc.indexOf('async', start);
  assert.ok(asyncAt > start, '找不到 text:can-reencode 的箭头函数起点');
  const bodyOpen = mainSrc.indexOf('{', asyncAt);
  assert.ok(bodyOpen > asyncAt, '找不到函数体开括号');
  const bodyEnd = srcScan.scanBrace(mainSrc, bodyOpen);
  assert.ok(bodyEnd > bodyOpen, '函数体括号不配平');
  const arrowSrc = mainSrc.slice(asyncAt, bodyEnd);   // 到配平的 '}' 为止，含它
  assert.ok(/^async\s*\(/.test(arrowSrc), '抽取起点不是 async 箭头函数：' + JSON.stringify(arrowSrc.slice(0, 40)));
  assert.ok(/\}$/.test(arrowSrc), '抽取的箭头函数不完整：' + JSON.stringify(arrowSrc.slice(-40)));
  assert.ok(arrowSrc.indexOf('supported') > 0, '抽到的片段里没有 supported 判据');

  /* 把 handler 包成可直接调用的函数。它内部只依赖 mojibake.normEnc 与几个常量，
   * 这里把这两样注进去（normEnc 用真实现，避免又一次「测副本」）。 */
  const mojibake = require('../lib/mojibake');
  /* 末尾可能带一个分号（`};`），构造函数表达式时必须剥掉，否则 `(async …};)` 是语法错误 */
  const exprSrc = arrowSrc.replace(/\}\s*;?\s*$/, '}');
  const handler = new Function('mojibake', 'return (' + exprSrc + ');')(mojibake);

  /* handler 是 async 的，返回 Promise —— 必须 await，直接读属性只会拿到 undefined */
  const gbkRes = await handler({}, '测试文本', 'gbk');
  assert.strictEqual(gbkRes.supported, false,
    'GBK 被当成了 Node 原生支持的编码（实际 Node 没有 GBK 编码器，转存后会是乱码）');
  const gb18030Res = await handler({}, '测试文本', 'gb18030');
  assert.strictEqual(gb18030Res.supported, false, 'GB18030 同上，不该被当成原生支持');
  /* 对照组：UTF-8 确实原生支持 —— 防「全都返回 false」这种退化 */
  const utf8Res = await handler({}, '测试文本', 'utf-8');
  assert.strictEqual(utf8Res.supported, true, 'UTF-8 应判定为原生支持（对照组）');
});

t('text:can-reencode 的 note 会区分原生支持与需要系统工具', () => {
  const main = strip(readMain({ raw: true }));
  const fn = main.match(/handle\('text:can-reencode'[\s\S]*?\n\}\);/);
  assert.ok(fn, '找不到 text:can-reencode');
  assert.ok(/supported/.test(fn[0]), '应返回 supported 判据');
  assert.ok(/系统工具|PowerShell/i.test(fn[0]),
    '对非原生编码应明确说需要借助系统工具完成');
});

/* ---------- 目录占用查询只注册普通文件 ----------
 * 实测（逐个二分）：注册目录或 junction 会让 RmGetList 整批返回
 * 错误码 5（Access denied），整个查询失败 —— 不是「这项没查到」。
 * 而用「目录搬家」搬过的目录里就有一个 junction，用户点「查占用」
 * 只会看到「Restart Manager 查询失败」。 */
t('file:who-locks-dir 只注册普通文件（目录/链接会让整批查询失败）', () => {
  const main = strip(readMain({ raw: true }));
  const fn = handlerBlock(main, 'file:who-locks-dir', 'dirMoveCh.ACL_LINKS.WHO_LOCKS_DIR');
  assert.ok(fn, '找不到 file:who-locks-dir');
  assert.ok(/readdir\(dir, \{ withFileTypes: true \}\)/.test(fn),
    '应用 withFileTypes 拿 Dirent，避免额外 stat 且不跟随链接');
  assert.ok(/if \(!ent\.isFile\(\)\)/.test(fn),
    '必须只收普通文件 —— 目录和链接都会让整批查询 ERR 5');
  assert.ok(/skipped/.test(fn), '跳过的项要如实计数并说明，不假装扫过全部');
});

t('file:who-locks-dir 不再把子目录/链接拼进查询列表', () => {
  const main = strip(readMain({ raw: true }));
  const fn = handlerBlock(main, 'file:who-locks-dir', 'dirMoveCh.ACL_LINKS.WHO_LOCKS_DIR');
  assert.ok(!/names\.slice\(0, 200\)|sample\.map/.test(fn),
    '不该再把整批 readdir 结果直接拼成查询列表');
});

t('9a parsePsDate 三种形态', () => {
  const code = stripComments(mainSrc);
  const i = code.indexOf('function parsePsDate');
  const j = code.indexOf("handle('sys:hw-info'");
  assert.ok(i > 0 && j > i, '找不到 parsePsDate');
  const f = new Function(code.slice(i, j) + '\nreturn { parsePsDate, normalizeDateFields };')();
  assert.strictEqual(f.parsePsDate('/Date(1793413286500)/'), 1793413286500, 'PS 5.1 的 /Date(ms)/ 必须解析成毫秒');
  assert.strictEqual(f.parsePsDate('2026-10-31T00:00:00Z'), new Date('2026-10-31T00:00:00Z').getTime(), 'ISO 也要能解析');
  assert.strictEqual(f.parsePsDate(null), null, 'null 应返回 null');
  assert.strictEqual(f.parsePsDate('garbage'), null, '解析不出来应返回 null（不能返回 NaN）');
  assert.strictEqual(f.parsePsDate(1793413286500), 1793413286500, '已经是数字就原样返回');
  // normalizeDateFields 要真正替换字段
  const n = f.normalizeDateFields({ LastBootUpTime: '/Date(1793413286500)/', InstallDate: null, Caption: 'x' });
  assert.strictEqual(n.LastBootUpTime, 1793413286500);
  assert.strictEqual(n.InstallDate, null);
  assert.strictEqual(n.Caption, 'x', '其它字段不该丢');
});

t('9b 渲染层不再渲染出 NaN', () => {
  const code = stripComments(read('js/tools/sys-tools.js'));
  assert.ok(/function fmtBoot/.test(code), '没有 fmtBoot 防御');
  const i = code.indexOf('function fmtBoot');
  const seg = code.slice(i, i + 900);
  assert.ok(/Number\.isFinite/.test(seg), 'flat 地调 fmtDate 会把 NaN 渲染成 NaN-NaN-NaN');
  assert.ok(/'-'/.test(seg), '取不到时应显示 -');
  /* 旧的直算写法必须消失 */
  assert.ok(!/fmtDate\(new Date\(info\.os\.LastBootUpTime\)\.getTime\(\)\)/.test(code),
    '仍在直接 new Date(...).getTime() 传给 fmtDate');
});

/* ==================== 10. 选择弹窗关闭后不能挂起 ==================== */

done();
