'use strict';
/* 目录搬家底层实现的行为测试（原 test-round12-fixes.js 迁移而来）。
 *
 * ============ 这个文件为什么存在 ============
 * 原先这 10 条断言埋在 test-round12-fixes.js 里。按轮次命名的问题不是"名字丑"，
 * 而是**想知道「搬家失败回滚有没有测」得挨个 grep 七个文件**。
 * 现在按被测对象组织：
 *   · 本文件  —— ipc/dir-acl-links.js 里的搬家底层实现
 *                （normalizeForComparePath / isInsideTree / copyTreeExcludingLinks /
 *                 restoreLinksIntoTarget / linkNature / linkTargetAbs）
 *   · test-dir-move.js       —— lib/dir-move.js 的 validateMove 与回退计划
 *   · test-file-unlock.js    —— js/tools/file-unlock.js（②③ 两条搬过去了）
 *
 * 【为什么这些函数要用 new Function 从源码里抽出来跑】
 * 它们在 ipc/dir-acl-links.js 里是 register(ctx, deps) 闭包内部的局部函数，
 * 没有对外导出。要跑真实现只能把源码段抽出来、注入它依赖的 fsp/path/fs。
 * 这是**真实现**，不是手写副本 —— 抽出来的文本与源码逐字一致，
 * 源码改了断言就会跟着变（这也是 test-round14 那条"测试跑的是副本"的教训）。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const { t, done, readMain } = require('./lib/harness');
const stripComments = require('../lib/src-scan').stripComments;

const mainSrc = readMain();

/* 抽出某个函数的完整源码段（按花括号配平）。 */
function extract(name, isAsync) {
  const pat = (isAsync ? 'async function ' : 'function ') + name + '(';
  const start = mainSrc.indexOf(pat);
  if (start < 0) throw new Error('主进程源码里找不到 ' + name);
  let i = mainSrc.indexOf('{', start), depth = 0;
  for (; i < mainSrc.length; i++) {
    if (mainSrc[i] === '{') depth++;
    else if (mainSrc[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return mainSrc.slice(start, i);
}
const pathExists = async (p) => { try { await fs.promises.access(p); return true; } catch (e) { return false; } };

/* 把搬家这一套辅助函数装进一个沙箱里跑。 */
function makeMoveSandbox() {
  return new Function('fsp', 'path', 'fs', 'pathExists',
    extract('relKey', false) + '\n'
    + extract('buildLinkKeySet', false) + '\n'
    + extract('linkNature', false) + '\n'
    + extract('linkTargetAbs', false) + '\n'
    + extract('normalizeForComparePath', false) + '\n'
    + extract('isInsideTree', false) + '\n'
    + extract('copyTreeExcludingLinks', true) + '\n'
    + extract('restoreLinksIntoTarget', true) + '\n'
    + 'return { copyTreeExcludingLinks, restoreLinksIntoTarget, linkNature, linkTargetAbs, isInsideTree, normalizeForComparePath };'
  )(fs.promises, path, fs, pathExists);
}

/* 用 FileSystemObject 取 8.3 短名。 */
function shortPath(p) {
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  return cp.execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `(New-Object -ComObject Scripting.FileSystemObject).GetFolder(${q(p)}).ShortPath`],
  { encoding: 'utf8' }).trim();
}

/* ================= 路径归一：8.3 短名 =================
 * 锁的是：isInsideTree 只做字符串比较时，用 8.3 短名写的内链认不出来，
 * 于是搬家时那条链接不会被改写 —— 源目录删掉之后目标侧变成死链，
 * 用户看到的是「文件都在，但有个目录打不开」。 */

t('normalizeForComparePath 把 8.3 短名解析成长名', () => {
  const mod = makeMoveSandbox();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-a-'));
  try {
    const long = path.join(root, 'VeryLongSourceDirectoryName');
    fs.mkdirSync(path.join(long, 'sub'), { recursive: true });
    let short = '';
    try { short = shortPath(long); } catch (e) { short = ''; }
    if (!short || short.toLowerCase() === long.toLowerCase()) {
      /* 【跳过必须让 CI 看见】
       * 原来这里只打一行带 6 个空格缩进的说明然后 return —— 既不 FAIL 也不 SKIP，
       * CI 的 `grep -E '^(FAIL|SKIP) '` 抓不到任何东西。
       * 后果：在关闭了 8.3 短名生成的卷（ntfs 8dot3name=0）上，
       * normalizeForComparePath 的短名解析能力**完全没被测过**，CI 照样全绿。 */
      console.log('SKIP 本机未生成 8.3 短名，normalizeForComparePath 的短名解析未被测到（卷可能关了 8dot3name）');
      return;
    }
    assert.ok(/~\d/.test(short), '短名应带 ~N：' + short);
    const a = mod.normalizeForComparePath(short).toLowerCase();
    const b = mod.normalizeForComparePath(long).toLowerCase();
    assert.strictEqual(a, b, '短名与长名应归一到同一个字面量：\n  短=' + a + '\n  长=' + b);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
});

t('用 8.3 短名写的内链：innerRewritten=1，源删掉后目标侧仍能 readdir', async () => {
  const mod = makeMoveSandbox();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-b-'));
  try {
    const long = path.join(root, 'VeryLongSourceDirectoryName');
    fs.mkdirSync(path.join(long, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(long, 'sub', 'inner.txt'), 'inner');

    let short = '';
    try { short = shortPath(long); } catch (e) { short = ''; }
    if (!short || short.toLowerCase() === long.toLowerCase()) {
      console.log('SKIP 本机未生成 8.3 短名，改用长名建同样的内链做等价验证');
      short = long;
    }
    const inner = path.join(long, 'inner');
    fs.symlinkSync(path.join(short, 'sub'), inner, 'junction');
    const declared = fs.readlinkSync(inner);

    assert.strictEqual(mod.isInsideTree(declared, long), true,
      '声明目标是 ' + declared + '，应判为「在源树内部」');
    /* 反向：源树之外的不能被误判成内部 */
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    assert.strictEqual(mod.isInsideTree(outside, long), false, '源树之外不该被判成内部');

    const dst = path.join(root, 'dst');
    await mod.copyTreeExcludingLinks(long, dst, [inner]);
    const rr = await mod.restoreLinksIntoTarget(long, dst, [inner], new Map());
    assert.strictEqual(rr.innerRewritten, 1, '应改写 1 个（实际 ' + rr.innerRewritten + '）');

    /* 走完「源改名 .bak → 删 .bak」 */
    fs.renameSync(long, long + '.hehe-bak');
    fs.rmSync(long + '.hehe-bak', { recursive: true, force: true });
    const names = fs.readdirSync(path.join(dst, 'inner'));   // 旧实现这里 ENOENT
    assert.ok(names.indexOf('inner.txt') !== -1, '应能读到链接里的文件：' + names.join(','));
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
});

t('悬空链接仍按字面比较（归一失败不能漏判）', () => {
  const mod = makeMoveSandbox();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-c-'));
  try {
    const src = path.join(root, 'src');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    /* 目标不存在（悬空）：realpath 会失败，必须退回 path.resolve 再比 */
    assert.strictEqual(mod.isInsideTree(path.join(src, 'sub', 'gone'), src), true,
      '悬空但字面上在源树内部 —— 归一失败时要退回字面比较');
    assert.strictEqual(mod.isInsideTree(path.join(root, 'elsewhere', 'gone'), src), false);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
});

t('预检的 innerLinkCount 用同一份判定', () => {
  const code = stripComments(mainSrc);
  /* 锁的是：预检自己算一遍「内部链接数」、搬家时再按另一套判据改写，
   * 两套判据一旦分叉，界面说「3 条内链会被改写」而实际改写 2 条。
   * 注释必须紧贴断言 —— 守门员只认上方 3 行。 */
  assert.ok(/isInsideTree\(linkTargetAbs\(l\), srcAbs\)/.test(code),
    '预检应复用同一个 isInsideTree（否则界面数字和实际行为对不上）');
});

t('SRC_IS_LINK：搬完之后再次搬家必须被拒（界面说法要对得上）', () => {
  const D = require('../lib/dir-move.js');
  const BS = String.fromCharCode(92);
  const r = D.validateMove({
    src: 'C:' + BS + 'Users' + BS + 'u' + BS + 'bigdir', dst: 'D:' + BS + 'backup' + BS + 'bigdir',
    srcExists: true, srcIsDir: true, srcIsLink: true, srcIsRoot: false, srcIsCritical: false,
    dstExists: false, needBytes: 1, freeBytes: 1e12, lockedPaths: [],
  });
  assert.strictEqual(r.code, 'SRC_IS_LINK');
  assert.ok(/链接/.test(r.reason), '理由要提到链接：' + r.reason);
});

done();
