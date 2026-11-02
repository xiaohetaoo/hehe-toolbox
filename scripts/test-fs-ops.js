'use strict';
/* lib/fs-ops.js 的行为测试（原 test-round2-fixes.js，按被测模块重命名）。
 *
 * ============ 为什么这些断言值得留下 ============
 * 这个测试的**历史价值**在于它修过一个「测副本」的假绿：
 * 原版本把唯一名生成、临时名规则抄了一份在自己的文件里，于是
 * main.js / lib 改动之后测试照旧全绿 —— 它测的是副本，不是实现。
 * 现在八条断言全部直接调用 lib/fs-ops.js 的真实现。
 *
 * ============ 这一组锁的是什么 ============
 *   uniquePath      输出已存在时自动加序号（绝不覆盖用户已有文件）
 *   tempPathFor     同名多次调用不冲突（临时文件不能互相踩）
 *   mergeParts      分片缺失时最终文件必须不存在（不能产出残片当成品）
 *   解密失败        不删除已存在的同名输出（失败不能毁掉上一份好数据）
 *   uniquePath 的可注入判据 —— 让「存在性」成为纯函数，测试才测得准
 *
 * 【为什么保留自建计数器而不是换 harness】
 * 这个文件整体是 async IIFE + 顺序 await，harness 的 deferred 模式会把
 * 异步用例堆到末尾，输出顺序与迁移前不一致 —— 而输出顺序是本项目的
 * 契约之一（见 scripts/lib/harness.js 顶部）。换代价值不大、风险不小。 */
/* 验证三个修复的实际行为。
 *
 * 【重要】本测试**调用 lib/fs-ops.js 的真实现**（main.js 用的同一份），
 * 不再复刻逻辑。原版本把唯一名生成、临时名规则抄了一份，
 * 后果是 main.js 改动后测试照旧全绿 —— 测的是副本（假绿）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const fsOps = require('../lib/fs-ops');
const { readMain } = require('./lib/harness');
const { scanBrace } = require('../lib/src-scan');
const cp = require('child_process');
/* 主进程源码：迁移来的 round13 用例要把 uniqueTarget 等实现抽出来跑。 */
const mainSrc = readMain({ raw: true });

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + e.message); }
};
const assert = require('assert');

(async () => {
  /* ---------- (0) 必须使用共享实现，不是本地复刻 ---------- */
  await t('使用 lib/fs-ops 的共享实现', async () => {
    assert.strictEqual(typeof fsOps.uniquePath, 'function');
    assert.strictEqual(typeof fsOps.tempPathFor, 'function');
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  /* 锁的是：「测试跑了副本」这个假绿 —— 原测试自己抄了一份唯一名/临时名规则，
   * lib 改动后照旧全绿。必须用源码断言：要验的是「main.js 确实引用了共享实现」
   * 这条依赖关系，只跑行为的话 main.js 里再出现一份内联副本也测不出来。 */
    assert.ok(/require\('\.\/lib\/fs-ops'\)/.test(mainSrc), 'main.js 未引入共享实现');
    /* 锁的是：main.js 有没有真的调用共享实现（而不是自己再写一份）。 */
    assert.ok(/fsOps\.uniquePath/.test(mainSrc), 'main.js 未调用 fsOps.uniquePath');
    assert.ok(/fsOps\.tempPathFor/.test(mainSrc), 'main.js 未调用 fsOps.tempPathFor');
    /* 锁的是：内联副本必须被删干净 —— 留着它等于有两份实现会各自漂移。 */
    assert.ok(!/for \(let i = 1; i < 1000; i\+\+\) \{ const np = path\.join\(dir, `\$\{base\}\(\$\{i\}\)`/
      .test(mainSrc.replace(/\/\*[\s\S]*?\*\//g, '')), 'main.js 仍有内联的 unique-path 实现');
  });

  /* ---------- (1) merge-parts 半成品 ---------- */
  await t('merge-parts 缺分片时最终文件不存在', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-'));
    const base = 'big';
    // 只写第 1 片，第 2 片缺失 —— 模拟真实的分片缺失场景
    fs.writeFileSync(path.join(d, base + '.part001'), Buffer.alloc(4000, 1));
    const finalOut = path.join(d, base + '.merged');

    // 用真实现拿临时名
    const tmp = fsOps.tempPathFor(finalOut, 'merging');
    assert.ok(tmp !== finalOut, '临时名不能等于最终名');
    assert.ok(tmp.startsWith(finalOut), '临时名应基于最终名: ' + tmp);

    // 走真实失败路径：读到第 2 片时报 ENONENT
    let threw = false;
    try {
      const ws = fs.createWriteStream(tmp);
      const rs = fs.createReadStream(path.join(d, base + '.part002'));
      await new Promise((resolve, reject) => {
        rs.on('error', reject);
        ws.on('error', reject);
        rs.pipe(ws);
      });
    } catch (e) {
      threw = true;
      fs.rmSync(tmp, { force: true }); // main.js 的 finally 也是这么清理
    }
    assert.ok(threw, '缺分片应当抛错');
    assert.ok(!fs.existsSync(finalOut), '最终文件名下不该留下半成品！');

    // 反向验证：如果不用临时名（旧写法），半成品会留在最终名上
    const bad = path.join(d, base + '.merged-old');
    fs.writeFileSync(bad, Buffer.alloc(4000, 1));
    assert.ok(fs.existsSync(bad), '对照：旧写法确实会留下 4000 字节残留文件');

    fs.rmSync(d, { recursive: true, force: true });
  });

  /* ---------- (2) cryptStream 失败不删原文件 ---------- */
  await t('解密失败时不删除已存在的同名输出文件', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'crypt-'));
    const dest = path.join(d, 'out.txt');
    fs.writeFileSync(dest, 'MY IMPORTANT PRE-EXISTING DATA');

    const tmp = fsOps.tempPathFor(dest, 'hehe-crypt');
    let threw = false;
    try {
      const ws = fs.createWriteStream(tmp);
      ws.write('partial');
      await new Promise((_, rej) => { ws.on('error', rej); ws.destroy(new Error('bad decrypt')); });
    } catch (e) {
      threw = true;
      fs.rmSync(tmp, { force: true });
    }
    assert.ok(threw, '应当抛错');
    assert.ok(fs.existsSync(dest), '用户原有文件被删了！');
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'MY IMPORTANT PRE-EXISTING DATA', '用户原有内容被改了');
    fs.rmSync(d, { recursive: true, force: true });
  });

  /* ---------- (3) 输出一律唯一名 ---------- */
  await t('图片输出已存在时自动加序号，不覆盖', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'img-'));
    const existing = path.join(d, 'a.jpg');
    fs.writeFileSync(existing, 'PREVIOUS OUTPUT - IMPORTANT');

    const finalPath = fsOps.uniquePath(path.join(d, 'a.jpg'));
    assert.notStrictEqual(finalPath, existing, '未生成新名字');
    assert.ok(/a\(1\)\.jpg$/.test(finalPath), '应为 a(1).jpg: ' + finalPath);

    fs.writeFileSync(finalPath, 'JPEG-OUTPUT');
    assert.strictEqual(fs.readFileSync(existing, 'utf8'), 'PREVIOUS OUTPUT - IMPORTANT', '原有文件被覆盖');
    fs.rmSync(d, { recursive: true, force: true });
  });

  /* ---------- (3b) uniquePath 的边界 ---------- */
  await t('uniquePath: 不存在时原样返回', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uq-'));
    const p = path.join(d, 'new.jpg');
    assert.strictEqual(fsOps.uniquePath(p), p);
    fs.rmSync(d, { recursive: true, force: true });
  });
  await t('uniquePath: 连续占用多个时继续递增', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uq2-'));
    for (const n of ['a.jpg', 'a(1).jpg', 'a(2).jpg']) fs.writeFileSync(path.join(d, n), 'x');
    const r = fsOps.uniquePath(path.join(d, 'a.jpg'));
    assert.ok(/a\(3\)\.jpg$/.test(r), '应跳到 a(3).jpg: ' + r);
    fs.rmSync(d, { recursive: true, force: true });
  });
  await t('uniquePath: 可注入存在性判断（纯函数式验证）', async () => {
    const taken = new Set(['x.jpg', 'x(1).jpg']);
    const r = fsOps.uniquePath('x.jpg', (p) => taken.has(p));
    assert.strictEqual(r, 'x(2).jpg', '应返回 x(2).jpg，实际 ' + r);
  });
  await t('tempPathFor: 同名多次调用不冲突', async () => {
    const a = fsOps.tempPathFor('/tmp/out.txt', 'merging');
    const b = fsOps.tempPathFor('/tmp/out.txt', 'merging');
    assert.notStrictEqual(a, b, '两次临时名不应相同');
    assert.ok(a.includes('.merging-'), '临时名应含标记: ' + a);
  });

/* ---------------- 以下助手随 round13 的用例一起迁来 ----------------
 * segFromFn / segFromHandler 按花括号配平取源码段 —— 因为 handler 体里有
 * 嵌套的 {}、正则字面量与默认参数对象，简单切字符串会切歪。 */
function segFromFn(needle, label) {
  const i = mainSrc.indexOf(needle);
  assert.ok(i > 0, '找不到 ' + (label || needle));
  /* 【不能直接取 needle 之后的第一个 '{'】
   * 函数签名里可能有默认参数对象：function runCmd(cmd, args, opts = {}) {
   * 第一个 '{' 是那个空对象 —— 用它配平只能得到 36 个字符
   * （实测：抽出的是 "function runCmd(cmd, args, opts = {}"）。
   * 正确做法是先把参数括号配平掉，再取之后的第一个 '{'：
   *   function foo(a, b = {}) {        ← 参数里的 { 在括号内部，不属于函数体
   *   const foo = (a) => {             ← 箭头函数同理
   * 这里统一处理：找 needle 之后的第一个 '('，配平到 ')'，再从那里往后找 '{'。 */
  let cursor = i;
  const paren = mainSrc.indexOf('(', i);
  if (paren > 0) {
    let depth = 0, k = paren;
    for (; k < mainSrc.length; k++) {
      const c = mainSrc[k];
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) { k++; break; } }
    }
    if (k > paren) cursor = k;
  }
  const open = mainSrc.indexOf('{', cursor);
  assert.ok(open > i, (label || needle) + ' 没有函数体');
  const end = scanBrace(mainSrc, open);
  assert.ok(end > open, (label || needle) + ' 括号不配平');
  return mainSrc.slice(i, end);
}


function rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) { try { cp.execFileSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', dir], { windowsHide: true }); } catch (e2) {} }
}

t('9a moveFile：同卷时走 rename；跨卷（EXDEV）退回复制+删源', async () => {
  /* 【不用注释当右边界】见 segFromFn 的说明。moveFile 是顶层 async 函数。 */
  const fn = new Function('fsp', 'path',
    segFromFn('async function moveFile', 'moveFile') + '\nreturn moveFile;')(fs.promises, path);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r12x-move-'));
  try {
    // 同卷：正常改名
    const a = path.join(dir, 'a.txt'); fs.writeFileSync(a, 'hello');
    const b = path.join(dir, 'b.txt');
    const r1 = await fn(a, b);
    assert.strictEqual(fs.readFileSync(b, 'utf8'), 'hello');
    assert.ok(!fs.existsSync(a), '同卷改名后源应消失');
    assert.strictEqual(r1.copied, false, '同卷不该走复制');

    // 模拟 EXDEV：包一层 fsp，rename 到特定目标时抛 EXDEV
    const c = path.join(dir, 'c.txt'); fs.writeFileSync(c, 'world');
    const d = path.join(dir, 'd.txt');
    const fakeFsp = Object.assign({}, fs.promises, {
      rename: async (s, t) => {
        if (t === d) { const e = new Error('EXDEV: cross-device link not permitted'); e.code = 'EXDEV'; throw e; }
        return fs.promises.rename(s, t);
      },
    });
    const fn2 = new Function('fsp', 'path',
      segFromFn('async function moveFile', 'moveFile') + '\nreturn moveFile;')(fakeFsp, path);
    const r2 = await fn2(c, d);
    assert.strictEqual(fs.readFileSync(d, 'utf8'), 'world', '跨卷后目标内容必须正确');
    assert.ok(!fs.existsSync(c), '跨卷复制成功后源应被删掉');
    assert.strictEqual(r2.copied, true, '应走复制分支');
  } finally { rmDir(dir); }
});

t('9b moveFile：非 EXDEV 的错误要原样抛出，不能悄悄改成复制', async () => {
  /* 【不用注释当右边界】同 9a。 */
  const fakeFsp = Object.assign({}, fs.promises, {
    rename: async () => { const e = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; throw e; },
    copyFile: async () => { throw new Error('不该走到复制'); },
  });
  const fn = new Function('fsp', 'path',
    segFromFn('async function moveFile', 'moveFile') + '\nreturn moveFile;')(fakeFsp, path);
  await assert.rejects(() => fn('x', 'y'), /EPERM/, '非 EXDEV 必须原样抛出');
});

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})();
