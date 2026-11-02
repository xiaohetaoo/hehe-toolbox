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
/* ---------------- 以下助手随 round11 的用例一起迁来 ----------------
 * 这些是「把源码段抽出来在沙箱里跑」的脚手架：extract() 按花括号配平取一个
 * 函数的完整源码，makeLinkNatures() 把 shortErr / linkNature / linkNatures
 * 三段拼起来求值。它们是**真实现**，不是手写副本。 */
const BS = String.fromCharCode(92);
const fsp = fs.promises;
/* PS_PATH_BATCH 在 main.js 里是常量，这里从源码里读出来（与实现同源）。 */
const mainSrc = readMain();
const PS_PATH_BATCH = Number((mainSrc.match(/const PS_PATH_BATCH = (\d+);/) || [])[1]);
function read(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }
function extract(name, isAsync) {
  const pat = (isAsync ? 'async function ' : 'function ') + name + '(';
  const start = mainSrc.indexOf(pat);
  if (start < 0) throw new Error('main.js 里找不到 ' + name);
  let i = mainSrc.indexOf('{', start), depth = 0;
  for (; i < mainSrc.length; i++) {
    if (mainSrc[i] === '{') depth++;
    else if (mainSrc[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return mainSrc.slice(start, i);
}

/* PowerShell 调用替身（原 test-round11 的 psStrict）：严格版本，非零退出即 reject。
 * 与生产的 ps() 不同 —— 生产版「非零不抛」，而这里要的是失败必须冒出来，
 * 否则测不到查询失败要如实回报这一类行为。 */
function psStrict(script, timeoutMs) {
  return new Promise((resolve, reject) => {
    cp.execFile('powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: timeoutMs || 60000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve({ stdout, stderr: '' })));
  });
}
function makeLinkNatures(ps) {
  return new Function('ps', 'fs', 'path', 'PS_PATH_BATCH',
    extract('shortErr', false) + '\n'
    + extract('linkNature', false) + '\n'
    + extract('linkNatures', true) + '\n'
    + 'return linkNatures;')(ps, fs, path, PS_PATH_BATCH);
}
/* ---------------------------------------------------------------- */

const stripComments = require('../lib/src-scan').stripComments;


/* 抽出某个函数的完整源码段（按花括号配平）。 */
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

/* 递归删临时目录（round9 的清理助手）。
 * 用 maxRetries 是因为 Windows 上刚关的句柄可能还占着几百毫秒，
 * 一次性 rmSync 会 EPERM —— 那不是失败，只是还没放开。 */
function rmDir(p) {
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (e) {}
}

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

t('源树内部的链接：搬家完成后目标侧仍能 readdir（不再变死链）', async () => {
  const mod = makeMoveSandbox();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r11-t1-'));
  try {
    const src = path.join(root, 'src');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src, 'sub', 'inner.txt'), 'inner');
    const back = path.join(src, 'sub', 'back');        // 目标落在源树内部
    fs.symlinkSync(path.join(src, 'sub'), back, 'junction');

    const links = [back];
    const dst = path.join(root, 'dst');
    await mod.copyTreeExcludingLinks(src, dst, links);
    const rr = await mod.restoreLinksIntoTarget(src, dst, links, new Map());
    assert.strictEqual(rr.created, 1, '应重建 1 个链接，实际 created=' + rr.created +
      ' failed=' + JSON.stringify(rr.failed));
    assert.deepStrictEqual(rr.failed, [], '不该有失败');
    assert.strictEqual(rr.innerRewritten, 1, '应记下 1 个「目标在源树内部」的改写');

    /* 走完第 3、6 步：源改名 .hehe-bak → 删 .bak */
    fs.renameSync(src, src + '.hehe-bak');
    fs.rmSync(src + '.hehe-bak', { recursive: true, force: true });

    const dstBack = path.join(dst, 'sub', 'back');
    const names = fs.readdirSync(dstBack);             // 旧实现这里会 ENOENT
    assert.ok(names.indexOf('inner.txt') !== -1, '应能读出链接内的文件：' + names.join(','));
    const tgt = fs.readlinkSync(dstBack);
    assert.ok(tgt.toLowerCase().indexOf(dst.toLowerCase()) === 0,
      '链接目标应改写为新位置，实际仍指向 ' + tgt);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

t('指向源目录自身的链接（. → src）也要改写', async () => {
  const mod = makeMoveSandbox();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r11-t2-'));
  try {
    const src = path.join(root, 'src');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src, 'marker.txt'), 'm');
    const self = path.join(src, 'sub', 'to-root');     // 指向源目录**自身**
    fs.symlinkSync(src, self, 'junction');
    const dst = path.join(root, 'dst');
    await mod.copyTreeExcludingLinks(src, dst, [self]);
    const rr = await mod.restoreLinksIntoTarget(src, dst, [self], new Map());
    assert.strictEqual(rr.innerRewritten, 1, '指向源自身的链接也应算「内部」');
    fs.renameSync(src, src + '.hehe-bak');
    fs.rmSync(src + '.hehe-bak', { recursive: true, force: true });
    const names = fs.readdirSync(path.join(dst, 'sub', 'to-root'));
    assert.ok(names.indexOf('marker.txt') !== -1, '应能读到源目录的内容：' + names.join(','));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

t('目标在源树之外的链接保持原样（不该被改写）', async () => {
  const mod = makeMoveSandbox();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r11-t3-'));
  try {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'o.txt'), 'o');
    const src = path.join(root, 'src');
    fs.mkdirSync(src, { recursive: true });
    const ext = path.join(src, 'ext');
    fs.symlinkSync(outside, ext, 'junction');
    const dst = path.join(root, 'dst');
    await mod.copyTreeExcludingLinks(src, dst, [ext]);
    const rr = await mod.restoreLinksIntoTarget(src, dst, [ext], new Map());
    assert.strictEqual(rr.innerRewritten, 0, '源树外的链接不该被改写');
    assert.strictEqual(rr.created, 1);
    assert.strictEqual(fs.readFileSync(path.join(dst, 'ext', 'o.txt'), 'utf8'), 'o');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

t('建完自检：链接指向的东西此刻不存在时必须报失败', async () => {
  const mod = makeMoveSandbox();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r11-t1b-'));
  try {
    const src = path.join(root, 'src');
    fs.mkdirSync(path.join(src, 'sub', 'deeper'), { recursive: true });
    const link = path.join(src, 'sub', 'back');
    fs.symlinkSync(path.join(src, 'sub', 'deeper'), link, 'junction');

    /* 目标侧只建了 dst 根：sub 会被 mkdir 出来，但 sub\deeper 没有 ——
     * 于是改写后的链接指向一个不存在的目录，正是自检要抓的形态。
     * （不调 copyTreeExcludingLinks，就是要让「内容没复制过去」这件事发生。） */
    const dst = path.join(root, 'dst');
    fs.mkdirSync(dst, { recursive: true });
    const rr = await mod.restoreLinksIntoTarget(src, dst, [link], new Map());
    assert.strictEqual(rr.created, 0, '这种情况下不允许报成功（实际 created=' + rr.created + '）');
    assert.strictEqual(rr.failed.length, 1, '应记一条失败：' + JSON.stringify(rr.failed));
    assert.ok(/重建后的链接打不开/.test(rr.failed[0].error),
      '错误信息应说明是「建完打不开」，实际：' + rr.failed[0].error);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
});

t('悬空链接的判据必须是 stat（access 会穿过悬空链接返回成功）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r11-t1c-'));
  try {
    const gone = path.join(root, 'gone');
    fs.mkdirSync(gone, { recursive: true });
    const j = path.join(root, 'j');
    fs.symlinkSync(gone, j, 'junction');
    fs.rmdirSync(gone);
    /* 这条断言记录的是 Node 的真实行为，是本修复的判据依据 */
    assert.strictEqual((() => { try { fs.accessSync(j); return true; } catch (e) { return false; } })(), true,
      'access 对悬空链接返回成功（正因如此不能拿它当「活着」的判据）');
    assert.strictEqual((() => { try { fs.statSync(j); return true; } catch (e) { return false; } })(), false,
      'stat 会跟随链接，目标不存在时报 ENOENT');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

t('源改名后的抽查（真正的兜底）：照抄旧路径的链接必须被拦住', async () => {
  const mod = makeMoveSandbox();
  /* 用「把 isInsideTree 换成恒 false」模拟老 bug，验证兜底不是摆设 */
  const OLD = new Function('fsp', 'path', 'fs', 'pathExists',
    extract('relKey', false) + '\n'
    + extract('buildLinkKeySet', false) + '\n'
    + extract('linkNature', false) + '\n'
    + extract('linkTargetAbs', false) + '\n'
    + 'function isInsideTree() { return false; }\n'
    + extract('copyTreeExcludingLinks', true) + '\n'
    + extract('restoreLinksIntoTarget', true) + '\n'
    + 'return { copyTreeExcludingLinks, restoreLinksIntoTarget };')(fsp, path, fs, pathExists);
  const VERIFY = new Function('fs', 'path', 'relKey',
    extract('verifyInnerLinksReadable', true) + '\nreturn verifyInnerLinksReadable;'
  )(fs, path, (root, full) => path.relative(path.resolve(root), path.resolve(full)).split(path.sep).join('/'));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r11-t1d-'));
  try {
    const src = path.join(root, 'src');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src, 'sub', 'inner.txt'), 'inner');
    const back = path.join(src, 'sub', 'back');
    fs.symlinkSync(path.join(src, 'sub'), back, 'junction');
    const dst = path.join(root, 'dst');
    await OLD.copyTreeExcludingLinks(src, dst, [back]);
    const rr = await OLD.restoreLinksIntoTarget(src, dst, [back], new Map());
    assert.strictEqual(rr.created, 1, '老实现会「成功」');
    assert.strictEqual(rr.srcReadableLinks.length, 1, '应记下「源侧可读」的链接供后面抽查');

    fs.renameSync(src, src + '.hehe-bak');    // 这一刻坏链才暴露
    const v = await VERIFY(dst, src, rr.srcReadableLinks);
    assert.strictEqual(v.ok, false, '源改名后必须拦下坏链，否则又是「搬家完成但链接是死的」');
    assert.ok(/打不开/.test(v.reason), '理由应说清是链接打不开：' + v.reason);

    /* 正确实现下同一个抽查必须通过 */
    const src2 = path.join(root, 'src2');
    fs.mkdirSync(path.join(src2, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src2, 'sub', 'i2.txt'), 'i2');
    const back2 = path.join(src2, 'sub', 'back');
    fs.symlinkSync(path.join(src2, 'sub'), back2, 'junction');
    const dst2 = path.join(root, 'dst2');
    await mod.copyTreeExcludingLinks(src2, dst2, [back2]);
    const rr2 = await mod.restoreLinksIntoTarget(src2, dst2, [back2], new Map());
    fs.renameSync(src2, src2 + '.hehe-bak');
    const v2 = await VERIFY(dst2, src2, rr2.srcReadableLinks);
    assert.strictEqual(v2.ok, true, '改写正确时抽查应通过：' + JSON.stringify(v2));

    /* 源侧本来就悬空的，不参与抽查（不误伤） */
    const src3 = path.join(root, 'src3');
    fs.mkdirSync(path.join(src3, 'sub'), { recursive: true });
    const gone = path.join(root, 'gone3');
    fs.mkdirSync(gone, { recursive: true });
    const dang = path.join(src3, 'sub', 'dang');
    fs.symlinkSync(gone, dang, 'junction');
    fs.rmdirSync(gone);
    const dst3 = path.join(root, 'dst3');
    await mod.copyTreeExcludingLinks(src3, dst3, [dang]);
    const rr3 = await mod.restoreLinksIntoTarget(src3, dst3, [dang], new Map());
    fs.renameSync(src3, src3 + '.hehe-bak');
    assert.strictEqual(rr3.srcReadableLinks.length, 0, '源侧悬空的链接不该进抽查清单');
    const v3 = await VERIFY(dst3, src3, rr3.srcReadableLinks);
    assert.strictEqual(v3.ok, true, '不该因此判搬家失败');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
});

t('第 5 步（源改名之后）真的会抽查目标树里的链接', () => {
  /* 这条用静态断言：完整流程横跨「复制 → 校验 → 改名 → 建链接 → 验证」，
   * 单测里复刻整条链的成本远大于收益，而这里要钉住的是「有没有接上」。
   * 行为层面的判据已由上面那条「源改名后的抽查」用例覆盖。 */
  const code = stripComments(mainSrc);
  assert.ok(/verifyInnerLinksReadable\(dstAbs, srcAbs, innerLinkCheckList\)/.test(code),
    '第 5 步没有调用 verifyInnerLinksReadable（源改名后就没人在看树里的链接了）');
  /* 必须在 linkcheck 这一段里、且排在 verifyLinkReadable 之后（源改名之后） */
  const seg = code.slice(code.indexOf("emit('linkcheck'"), code.indexOf("emit('linkcheck'") + 1200);
  assert.ok(/verifyLinkReadable/.test(seg), 'linkcheck 段里应先验顶层链接');
  assert.ok(/verifyInnerLinksReadable/.test(seg), 'linkcheck 段里必须有树内链接抽查');
  assert.ok(seg.indexOf('verifyLinkReadable') < seg.indexOf('verifyInnerLinksReadable'),
    '抽查应排在顶层验证之后');
  /* 抽查清单必须由复制阶段传下来，且不能恒为空 */
  assert.ok(/innerLinkCheckList = linkRestore\.srcReadableLinks/.test(code),
    '复制阶段没有把「源侧可读的链接」交给第 5 步');
  assert.ok(/let innerLinkCheckList = \[\];/.test(code), 'innerLinkCheckList 应有函数级作用域声明');
});

t('预检返回 innerLinkCount，界面也用它', () => {
  const code = stripComments(mainSrc);
  assert.ok(/innerLinkCount/.test(code), 'main.js 没返回 innerLinkCount');
  const ui = read('js/tools/dir-move.js');
  assert.ok(/r\.innerLinkCount/.test(ui), '界面没用 innerLinkCount');
  assert.ok(/改写成新位置的对应路径/.test(ui), '界面应说清「会改写」而不是「原样重建」');
  assert.ok(!/个（会原样重建到新位置）/.test(ui), '仍保留了「一律原样重建」的旧文案');
});

/* ================= ② 电源门禁 ================= */

t('两处批量 Get-Item 都按 PS_PATH_BATCH 分块', () => {
  const code = stripComments(mainSrc);
  assert.ok(/const PS_PATH_BATCH = \d+;/.test(code), '没有分块常量');
  assert.ok(PS_PATH_BATCH >= 10 && PS_PATH_BATCH <= 200,
    '分块大小应在 10~200 之间（太小起进程多、太大会超命令行上限），实际 ' + PS_PATH_BATCH);
  const hits = (code.match(/i \+= PS_PATH_BATCH/g) || []).length;
  assert.ok(hits >= 2, 'link:scan 与 linkNatures 两处都要分批，实际 ' + hits + ' 处');
  assert.ok(!/const arr = found\.map\(q\)\.join\(','\)/.test(code),
    'link:scan 仍把全部路径拼成一条');
});

t('600 个长路径：不抛 ENAMETOOLONG，结构完整', async () => {
  const linkNatures = makeLinkNatures(psStrict);
  const many = [];
  for (let i = 0; i < 600; i++) {
    many.push(path.join(os.tmpdir(), 'r11-nope-' + i + '-' + 'x'.repeat(70), 'link-' + i));
  }
  /* 先确认「不分批会炸」，证明这条用例有意义 */
  let unsplitFails = false;
  try {
    cp.execFileSync('powershell', ['-NoProfile', '-Command',
      'Get-Item -LiteralPath @(' + many.map((x) => "'" + x + "'").join(',') + ') -ErrorAction SilentlyContinue'],
    { encoding: 'utf8', timeout: 30000, stdio: 'pipe' });
  } catch (e) { unsplitFails = /ENAMETOOLONG/.test(String(e.code) + String(e.message)); }
  if (!unsplitFails) {
    console.log('      （提示）本机命令行上限比 32767 宽松，未复现 ENAMETOOLONG，仍验证分批结构');
  }
  const r = await linkNatures(many);
  assert.ok(r.natures instanceof Map, '应返回 {natures, error}');
  assert.strictEqual(r.natures.size, 0, '这些路径都不存在，应全部判不出来');
  assert.strictEqual(r.error, null, '悬空/不存在不是系统性失败，error 应为 null：' + r.error);
});

/* ================= ④ 源受保护原因 ================= */

t('SRC_CRITICAL 的 reason 里带上具体原因（与目标侧对齐）', () => {
  const D = require('../lib/dir-move.js');
  const reason = '这是你自己的用户目录本身，修改它的权限会波及下面所有文件；请选中具体的文件或子文件夹';
  const r = D.validateMove({
    src: 'C:' + BS + 'Users' + BS + 'u', dst: 'D:' + BS + 'backup',
    srcExists: true, srcIsDir: true, srcIsLink: false, srcIsRoot: false,
    srcIsCritical: true, srcProtectedKind: 'OWN_HOME', srcProtectedReason: reason,
    dstExists: false, needBytes: 1, freeBytes: 1e12, lockedPaths: [],
  });
  assert.strictEqual(r.code, 'SRC_CRITICAL');
  assert.ok(r.reason.indexOf(reason) !== -1, 'reason 里没有具体原因：' + r.reason);
  assert.ok(/具体子文件夹/.test(r.advice), 'OWN_HOME 的建议应指向子文件夹：' + r.advice);
  /* 没传原因时退回原来的笼统文案，不崩 */
  const r2 = D.validateMove({
    src: 'C:' + BS + 'Windows', dst: 'D:' + BS + 'b',
    srcExists: true, srcIsDir: true, srcIsLink: false, srcIsRoot: false,
    srcIsCritical: true, dstExists: false, needBytes: 1, freeBytes: 1e12, lockedPaths: [],
  });
  assert.strictEqual(r2.reason, '源目录位于系统关键目录内，拒绝操作');
});

t('main.js 两处都把 srcProtectedReason 传给 validateMove', () => {
  const code = stripComments(mainSrc);
  const hits = (code.match(/srcProtectedReason:/g) || []).length;
  assert.ok(hits >= 3, '预检与执行都应传（含返回值），实际 ' + hits + ' 处');
});

/* ================= ⑤ linkNatures 失败上报 ================= */

t('真失败会带 error 出来，且文案被截断', async () => {
  const failing = makeLinkNatures(() => Promise.reject(
    Object.assign(new Error('spawn powershell ENAMETOOLONG'), { code: 'ENAMETOOLONG' })));
  const r = await failing([path.join(os.tmpdir(), 'a'), path.join(os.tmpdir(), 'b')]);
  assert.ok(r.error, '查询失败必须带 error 出来');
  assert.ok(/ENAMETOOLONG/.test(r.error), 'error 里应有错误码：' + r.error);
  assert.ok(String(r.error).length < 300, 'error 文案应被截断（不塞整条命令行）：' + String(r.error).length);
});

t('悬空链接不算查询失败（它本来就正常）', async () => {
  const linkNatures = makeLinkNatures(psStrict);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r11-t5-'));
  try {
    const gone = path.join(root, 'gone');
    fs.mkdirSync(gone, { recursive: true });
    const dangling = path.join(root, 'dangling');
    fs.symlinkSync(gone, dangling, 'junction');
    fs.rmdirSync(gone);                      // 目标删掉 → 悬空 junction
    const r = await linkNatures([dangling]);

    /* ① 悬空链接**不是**查询失败 —— 任何环境都必须成立。
     *    查不到性质 ≠ 查询失败；后者会让搬运被整体拒掉。 */
    assert.strictEqual(r.error, null, '悬空链接不该被报成查询失败：' + r.error);

    /* ② 【关键不变量：读不到时不能猜成 'file'】
     * 这条才是真正会酿成事故的一层。实测两个环境行为不同：
     *   本机：Attributes 含 Directory → 判出 'dir'
     *   GitHub windows-latest：Attributes 为空串 → 旧实现走 else 判成 'file'
     * 判成 'file' 的后果不是显示错误，而是重建走 fsp.symlink()（需要
     * SeCreateSymbolicLinkPrivilege），非管理员下必然 EPERM，搬家中止回滚 ——
     * 能不能搬成功居然取决于 PowerShell 读不读得到那个 Attributes。
     * 所以断言的是「要么判出 dir，要么干脆不登记」，绝不能是 'file'。 */
    const n = r.natures.get(dangling.toLowerCase());
    if (n === undefined) {
      console.log('      （提示）本机 PowerShell 读不到悬空 junction 的 Attributes → 不登记（正确行为）');
    } else {
      assert.strictEqual(n, 'dir',
        '悬空 junction 若能判出性质，必须是「目录」；判成 ' + n + ' 会让重建走需要特权的符号链接分支');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

t('问题1：两处占用检查都用 collectLockProbe（只注册普通文件）', () => {
  const code = stripComments(mainSrc);
  const n = (code.match(/collectLockProbe\(/g) || []).length;
  /* 定义 1 次 + 两处调用 */
  assert.ok(n >= 3, 'collectLockProbe 出现 ' + n + ' 次，应有定义 + 两处调用');
  assert.ok(!/names\.map\(\(n\)\s*=>\s*path\.join\(srcAbs,\s*n\)\)/.test(code),
    '还在把 readdir 的全部条目名拼成 probe（目录/链接会留下，整批 ERR 5）');
});

t('问题1：collectLockProbe 只收 isFile()，且不跟随链接', () => {
  const fn = mainSrc.match(/async function collectLockProbe\(dir\)[\s\S]*?\n\}/);
  assert.ok(fn, '找不到 collectLockProbe');
  const code = stripComments(fn[0]);
  assert.ok(/withFileTypes: true/.test(code), '必须用 withFileTypes 拿 Dirent');
  assert.ok(/if \(!ent\.isFile\(\)\) continue;/.test(code),
    '必须只收普通文件 —— 目录/junction 会让整批查询 ERR 5');
});

t('问题1：占用查询失败不再被 .catch(() => null) 静默吞掉', () => {
  const code = stripComments(mainSrc);
  /* 只检查搬家相关的两段：不允许出现「rmQueryLockers(...).catch(() => null)」 */
  assert.ok(!/rmQueryLockers\([^)]*\)\.catch\(\(\)\s*=>\s*null\)/.test(code),
    '仍在用 .catch(() => null) 把查询失败吞成「没有占用」');
  assert.ok(/lockCheckError/.test(code),
    '应把查询失败带进 lockCheckError，让用户看到「查询失败」而不是「没有占用」');
});

t('问题1（行为）：含 junction 的目录，collectLockProbe 不会把链接注册进去', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lkp-'));
  const src = path.join(root, 'src');
  fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(src, 'a.txt'), 'a');
  fs.writeFileSync(path.join(src, 'sub', 'b.txt'), 'b');
  const junction = path.join(src, 'jlink');
  try {
    cp.execFileSync('cmd.exe', ['/c', 'mklink', '/J', junction, path.join(src, 'sub')],
      { windowsHide: true, stdio: 'ignore' });

    /* 抽出真实现求值 */
    const srcFn = mainSrc.match(/async function collectLockProbe\(dir\)[\s\S]*?\n\}/)[0];
    const fsp = fs.promises;
    const fn = new Function('fsp', 'path', srcFn + '\nreturn collectLockProbe;')(fsp, path);
    const r = await fn(src);

    assert.strictEqual(r.error, null, '不该报错：' + r.error);
    assert.strictEqual(r.files.length, 1, '只应收 1 个普通文件，实际 ' + r.files.length);
    assert.ok(r.files[0].endsWith('a.txt'), '收到的应是 a.txt，实际 ' + r.files[0]);
    /* 关键：链接和子目录都不在里面 */
    assert.ok(!r.files.some((f) => f.indexOf('jlink') !== -1), '链接不该被注册（会让整批 ERR 5）');
    assert.ok(!r.files.some((f) => f.indexOf('sub') !== -1), '子目录不该被注册');
  } finally { rmDir(root); }
});

/* ================= 问题 2：mine 精确匹配，不做子串 ================= */

t('问题5：不再用 fsp.cp 直接复制整棵树（会被 junction 打成 EPERM）', () => {
  const code = stripComments(mainSrc);
  assert.ok(!/await fsp\.cp\(srcAbs, dstAbs/.test(code),
    '仍在用 fsp.cp 整树复制 —— 遇到 junction 会 EPERM');
  assert.ok(/copyTreeExcludingLinks/.test(code), '应有「排除链接后复制」的实现');
  assert.ok(/restoreLinksIntoTarget/.test(code), '应有「在目标侧重建链接」的实现');
  assert.ok(!/dereference:\s*true/.test(code),
    '不能靠 dereference: true 绕过 —— 那会把链接目标内容整个复制进来');
});

t('问题5（行为）：源目录含 junction 时，复制 + 重建能完成', async () => {
  const fsp = fs.promises;
  function extract(name, isAsync) {
    const pat = (isAsync ? 'async function ' : 'function ') + name + '(';
    const start = mainSrc.indexOf(pat);
    if (start < 0) throw new Error('not found: ' + name);
    let i = mainSrc.indexOf('{', start);
    let depth = 0;
    for (; i < mainSrc.length; i++) {
      if (mainSrc[i] === '{') depth++;
      else if (mainSrc[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return mainSrc.slice(start, i);
  }
  const pathExists = async (p) => { try { await fsp.access(p); return true; } catch (e) { return false; } };
  /* 沙箱要跟上 main.js 的实现：restoreLinksIntoTarget 现在依赖
   * linkTargetAbs / isInsideTree（内部链接改写），缺了会直接报未定义。 */
  const mod = new Function('fsp', 'path', 'fs', 'pathExists',
    extract('relKey', false) + '\n' + extract('buildLinkKeySet', false) + '\n'
    + extract('linkNature', false) + '\n'
    + extract('linkTargetAbs', false) + '\n'
    + extract('normalizeForComparePath', false) + '\n'
    + extract('isInsideTree', false) + '\n'
    + extract('copyTreeExcludingLinks', true) + '\n' + extract('restoreLinksIntoTarget', true) + '\n'
    + 'return { copyTreeExcludingLinks, restoreLinksIntoTarget, linkNature };')(fsp, path, fs, pathExists);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mvj2-'));
  const src = path.join(root, 'src');
  fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(src, 'plain.txt'), 'plain');
  fs.writeFileSync(path.join(src, 'sub', 'inner.txt'), 'inner');
  const junction = path.join(src, 'jlink');
  try {
    cp.execFileSync('cmd.exe', ['/c', 'mklink', '/J', junction, path.join(src, 'sub')],
      { windowsHide: true, stdio: 'ignore' });

    const dst = path.join(root, 'dst');
    /* 与 main.js 里 collectLinks 同语义的收集（不跟随链接） */
    const links = [junction];
    await mod.copyTreeExcludingLinks(src, dst, links);
    assert.ok(fs.existsSync(path.join(dst, 'plain.txt')), '普通文件应被复制');
    assert.ok(fs.existsSync(path.join(dst, 'sub', 'inner.txt')), '子目录文件应被复制');
    assert.ok(!fs.existsSync(path.join(dst, 'jlink')), '复制阶段不该碰链接');

    const rr = await mod.restoreLinksIntoTarget(src, dst, links);
    assert.strictEqual(rr.created, 1, '链接应被重建，实际 created=' + rr.created +
      ' failed=' + JSON.stringify(rr.failed));
    assert.ok(fs.lstatSync(path.join(dst, 'jlink')).isSymbolicLink(), '目标侧应是真正的链接');
    assert.strictEqual(fs.readFileSync(path.join(dst, 'jlink', 'inner.txt'), 'utf8'), 'inner',
      '通过目标侧链接应能读到内容');
  } finally { rmDir(root); }
});

t('问题5：重建失败不会被静默吞掉（应中止并回退）', () => {
  const code = stripComments(mainSrc);
  assert.ok(/linkRestore\.failed/.test(code), '应检查重建失败列表');
  assert.ok(/重建链接失败/.test(code), '失败时应给出明确错误');
});

/* ================= 问题 6：splash 注入 + 配平断言 ================= */

t('问题8：lockedPaths 不再假设 lockers 元素有 files 字段', () => {
  const code = stripComments(mainSrc);
  assert.ok(!/x\.files\s\?\s*x\.files\.join/.test(code),
    '仍在用 x.files（rmQueryLockers 返回的 {pid,name,type} 根本没有这个字段）');
});

t('问题8：LOCKED 文案说「进程」不说「文件」，advice 指向占用解锁工具', () => {
  const D = require('../lib/dir-move');
  const r = D.validateMove(Object.assign({}, {
    src: 'C:' + BS + 'a', dst: 'D:' + BS + 'a',
    srcExists: true, srcIsDir: true, srcIsLink: false, srcIsRoot: false,
    srcIsCritical: false, dstExists: false,
    needBytes: 1000, freeBytes: 10 * 1024 * 1024 * 1024,
    lockedPaths: ['123:foo.exe', '456:bar.exe'],
  }));
  assert.strictEqual(r.code, 'LOCKED');
  assert.ok(/个进程/.test(r.reason), '应说「N 个进程」而不是「N 个文件」：' + r.reason);
  assert.ok(!/个文件/.test(r.reason), '不该再说是文件数：' + r.reason);
  assert.ok(/文件占用解锁/.test(r.advice), 'advice 应指向占用解锁工具：' + r.advice);
});

/* ================= 额外项 ================= */

done();
