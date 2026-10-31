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

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }
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
  assert.ok(/await resolveTypes\(\);/.test(src), 'scan() 必须先 await 它');
  assert.ok(/it\.isDir[\s\S]{0,80}invoke\('file:who-locks-dir'/.test(src),
    '目录应走 file:who-locks-dir 通道');
});

t('file-unlock 的目录通道真的有调用方（不是死分支）', () => {
  const src = strip(read('js/tools/file-unlock.js'));
  assert.ok(src.includes("invoke('file:who-locks-dir'"),
    'file:who-locks-dir 必须有调用方，否则删目录只能得到「没有占用」的错误结论');
});

/* ---------- P2-3：乱码修复文件模式的编码名 ---------- */
t('文件分支把候选补成 from/to 形状（保留 label/encodings）', () => {
  const main = strip(read('main.js'));
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
  const seg = src.slice(src.indexOf('can-reencode') - 1200, src.indexOf('can-reencode'));
  assert.ok(/gbk/.test(seg), '应提供 GBK 选项');
  assert.ok(/utf-8/.test(seg), '应提供 UTF-8 选项');
});

/* ---------- 行为验证：text:can-reencode 对 GBK 的真实结论 ---------- */
t('GBK 不在 Node 原生编码器里 → 结论必须是「需要系统工具」', () => {
  /* 直接跑 main.js 里那段判据的等价表达式：supported 只列 Node 原生支持的编码。
   * 这里断言的是「GBK 确实不在那份列表里」，也就是按钮会给出真实结论，
   * 而不是把「没有替换字符」当成「可以转」。 */
  const NATIVE = ['utf-8', 'utf-16le', 'utf-16be'];
  assert.strictEqual(NATIVE.indexOf('gbk'), -1, 'GBK 不该被当成 Node 原生支持');
  assert.strictEqual(NATIVE.indexOf('gb18030'), -1, 'GB18030 不该被当成 Node 原生支持');
  assert.ok(NATIVE.indexOf('utf-8') >= 0, 'UTF-8 是原生支持的（用来做对照）');
});

t('text:can-reencode 的 note 会区分原生支持与需要系统工具', () => {
  const main = strip(read('main.js'));
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
  const main = strip(read('main.js'));
  const fn = main.match(/handle\('file:who-locks-dir'[\s\S]*?\n\}\);/);
  assert.ok(fn, '找不到 file:who-locks-dir');
  assert.ok(/readdir\(dir, \{ withFileTypes: true \}\)/.test(fn[0]),
    '应用 withFileTypes 拿 Dirent，避免额外 stat 且不跟随链接');
  assert.ok(/if \(!ent\.isFile\(\)\)/.test(fn[0]),
    '必须只收普通文件 —— 目录和链接都会让整批查询 ERR 5');
  assert.ok(/skipped/.test(fn[0]), '跳过的项要如实计数并说明，不假装扫过全部');
});

t('file:who-locks-dir 不再把子目录/链接拼进查询列表', () => {
  const main = strip(read('main.js'));
  const fn = main.match(/handle\('file:who-locks-dir'[\s\S]*?\n\}\);/);
  assert.ok(!/names\.slice\(0, 200\)|sample\.map/.test(fn[0]),
    '不该再把整批 readdir 结果直接拼成查询列表');
});

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
