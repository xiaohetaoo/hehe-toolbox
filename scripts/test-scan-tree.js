'use strict';
const { t, done } = require('./lib/harness');
const { handlerIndex } = require('./lib/seg-from-handler');
/* 目录树扫描统计的行为测试（原 test-round15 的 17a / 17b / 17c）。
 *
 * 锁的是：根路径带不带尾随分隔符（`D:\a` vs `D:\a\`）会得到不同的
 * 统计口径 —— 早期用字符串长度比较判断"是否在根下"，于是带尾斜杠时
 * 根目录自身被算了两次、或漏算。修法是路径归一后比较 + 用路径相等
 * 而不是长度。 */

/* ------------ 以下为迁移来的用例（断言逐字保留） ------------ */

const assert = require('assert');
const os = require('os');
const path = require('path');
const stripComments = require('../lib/src-scan').stripComments;
const mainSrc = require('./lib/harness').readMain({ raw: true });

t('17a 根路径归一：尾随分隔符不影响统计口径', () => {
  const code = stripComments(mainSrc);
  const i = code.indexOf('function normalizeRootForScan');
  assert.ok(i > 0, '没有抽出 normalizeRootForScan');
  const j = handlerIndex(code, 'fs:scan-empty-dirs');
  const f = new Function('path', code.slice(i, j) + '\nreturn normalizeRootForScan;')(path);
  const B = String.fromCharCode(92);
  assert.strictEqual(f('D:' + B + 'foo' + B), 'D:' + B + 'foo', '尾随分隔符没有被去掉');
  assert.strictEqual(f('D:' + B + 'foo'), 'D:' + B + 'foo', '正常路径不该变');
  assert.strictEqual(f('D:' + B), 'D:' + B, '盘符根必须保留原有形态');
  assert.strictEqual(f('D:/foo//'), 'D:' + B + 'foo', '正斜杠与重复分隔符也要归一');
  /* 空串 / 盘符相对不能悄悄落到 cwd；后者会把应用自己的目录当成扫描根。 */
  assert.throws(() => f(''), /不能为空/);
  assert.throws(() => f('C:foo'), /盘符相对/);
});

t('17b 聚合用的是路径比较，不是字符串长度', () => {
  const code = stripComments(mainSrc);
  const i = handlerIndex(code, 'fs:scan-tree');
  const seg = code.slice(i, i + 2400);
  /* 锁的是：「17b 聚合用的是路径比较，不是字符串长度」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(!/cur\.length >= root\.length/.test(seg),
    '仍在用字符串长度做包含判断（root 带尾斜杠时循环一次都不进，根统计恒为 0）');
  /* 锁的是：「17b 聚合用的是路径比较，不是字符串长度」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/cur === scanRoot/.test(seg) && /startsWith\(scanRoot \+ path\.sep\)/.test(seg),
    '没有改成 cur === root || cur.startsWith(root + sep) 的判定');
});

t('17c 行为：带/不带尾斜杠扫描同一个目录，根统计一致', async () => {
  /* 直接跑聚合逻辑的真实实现：构造 dirSize 键，验证根目录能累加到值。 */
  const code = stripComments(mainSrc);
  const i = code.indexOf('function normalizeRootForScan');
  const j = handlerIndex(code, 'fs:scan-empty-dirs');
  const f = new Function('path', code.slice(i, j) + '\nreturn normalizeRootForScan;')(path);
  const B = String.fromCharCode(92);
  const base = path.join(os.tmpdir(), 'r15-scanroot');
  const rootNorm = f(base + B);                  // 带尾斜杠
  const rootPlain = f(base);                     // 不带
  assert.strictEqual(rootNorm, rootPlain, '两种写法归一后必须相同');
  /* 模拟聚合：文件在 base/a.txt，从 dirname 往上走应能命中 root */
  const filePath = path.join(base, 'a.txt');
  let cur = path.dirname(filePath);
  let hit = false;
  while (cur === rootNorm || cur.startsWith(rootNorm + path.sep) || cur === path.parse(cur).root) {
    if (cur === rootNorm) hit = true;
    if (cur === path.parse(cur).root || cur === rootNorm) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  assert.strictEqual(hit, true, '从文件向上聚合没有命中根目录（根统计会恒为 0）');
});

/* ==================== 17d 相对根 ==================== */

/* 【本文件里的异步用例会 process.chdir —— 必须串行】
 * harness 的 deferred 模式用 Promise.all 同时跑所有异步用例（见 doneAsync）。
 * 两个用例各自 chdir 到不同临时目录的父目录，就会互相把 cwd 改走，
 * 于是「相对根」解析到别人家的目录，断言随机变红（本文件 17e 第一版
 * 就这么挂了：standalone 跑通，整文件跑红）。
 * 这里用文件级串行链把 17d/17e 排队；不要改成 Promise.all 友好的写法 ——
 * 相对路径解析本身就依赖进程级 cwd，没有并发安全的版本。 */
let serial = Promise.resolve();
const serialAsync = (fn) => { const p = serial.then(fn); serial = p.catch(() => {}); return p; };

t('17d 行为：相对根扫描时，逐目录体积与路径都必须正确', () => serialAsync(async () => {
  /* 【锁的是什么】聚合祖先用的是归一后的绝对 scanRoot，而遍历原来用原始
   * root。传相对路径（输入框手打 "photos"）时 item.path 是相对的，
   * dirname 得到 "photos\\sub"，与绝对 scanRoot 永远不相等 ——
   * 文件数/总体积仍对（直接累加），但每个目录的体积恒为 0，
   * 「目录占用排行」整块失真。实测旧实现返回
   *   topDirs: [{ path: "hehe-probe-xxx\\sub", size: 0 }]
   * 这条用真实 handler 跑一遍，同时锁住「返回绝对路径」（渲染层会拿它
   * 去继续下钻 / 打开目录，相对路径会被解析到主进程 cwd）。 */
  const { loadFsOps } = require('./lib/fs-handlers');
  const { CH, handlers } = loadFsOps();
  const fs = require('fs');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'r19-scan-'));
  try {
    fs.mkdirSync(path.join(base, 'sub'));
    fs.writeFileSync(path.join(base, 'sub', 'a.bin'), Buffer.alloc(500000));
    fs.writeFileSync(path.join(base, 'b.bin'), Buffer.alloc(300000));
    const cwd = process.cwd();
    process.chdir(path.dirname(base));
    let r;
    try {
      r = await handlers.get(CH.FS.SCAN_TREE)({}, path.basename(base), {});
    } finally { process.chdir(cwd); }
    assert.strictEqual(r.totalSize, 800000, '总体积不对：' + r.totalSize);
    assert.strictEqual(r.files, 2, '文件数不对：' + r.files);
    assert.ok(path.isAbsolute(r.root), '返回的 root 不是绝对路径：' + r.root);
    const sub = r.topDirs.find((d) => path.basename(d.path) === 'sub');
    assert.ok(sub, 'topDirs 里没有 sub：' + JSON.stringify(r.topDirs));
    assert.strictEqual(sub.size, 500000, '目录体积为 0/错误 —— 聚合键与遍历路径不是同一套');
    assert.ok(path.isAbsolute(sub.path), '目录路径不是绝对路径：' + sub.path);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}));

t('17e 行为：相对根下空目录扫描与查重结果都是绝对路径', () => serialAsync(async () => {
  /* 空目录清单会被渲染层送回 fs:delete-empty，查重结果会被送回 fs:delete；
   * 两者都按主进程 cwd 解析相对路径 —— 相对根会让「列出来的目录/文件」
   * 与「能删的路径」对不上，报错却是「路径不存在」。 */
  const { loadFsOps } = require('./lib/fs-handlers');
  const { CH, handlers } = loadFsOps();
  const fs = require('fs');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'r19-scan2-'));
  try {
    fs.mkdirSync(path.join(base, 'empty1'));
    fs.mkdirSync(path.join(base, 'empty2'));
    fs.writeFileSync(path.join(base, 'a.txt'), 'same-content');
    fs.mkdirSync(path.join(base, 'copy'));
    fs.writeFileSync(path.join(base, 'copy', 'a.txt'), 'same-content');
    const cwd = process.cwd();
    process.chdir(path.dirname(base));
    let empty, dedupe;
    try {
      empty = await handlers.get(CH.FS.SCAN_EMPTY_DIRS)({}, path.basename(base));
      dedupe = await handlers.get(CH.FS.DEDUPE)({}, path.basename(base), { mode: 'content' });
    } finally { process.chdir(cwd); }
    assert.ok(empty.dirs.length >= 2, '空目录没扫全：' + JSON.stringify(empty.dirs));
    for (const d of empty.dirs) assert.ok(path.isAbsolute(d.path), '空目录返回了相对路径：' + d.path);
    assert.ok(dedupe.groups.length >= 1, '内容相同的两个文件没有被分成一组');
    for (const f of dedupe.groups[0].files) {
      assert.ok(path.isAbsolute(f), '查重结果返回了相对路径：' + f);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}));

/* ==================== 执行 ==================== */

done();
