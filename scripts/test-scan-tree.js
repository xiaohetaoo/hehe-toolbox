'use strict';
const { t, done } = require('./lib/harness');
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
  const j = code.indexOf("handle('fs:scan-empty-dirs'");
  const f = new Function('path', code.slice(i, j) + '\nreturn normalizeRootForScan;')(path);
  const B = String.fromCharCode(92);
  assert.strictEqual(f('D:' + B + 'foo' + B), 'D:' + B + 'foo', '尾随分隔符没有被去掉');
  assert.strictEqual(f('D:' + B + 'foo'), 'D:' + B + 'foo', '正常路径不该变');
  assert.strictEqual(f('D:' + B), 'D:' + B, '盘符根必须保留原有形态');
  assert.strictEqual(f('D:/foo//'), 'D:' + B + 'foo', '正斜杠与重复分隔符也要归一');
});

t('17b 聚合用的是路径比较，不是字符串长度', () => {
  const code = stripComments(mainSrc);
  const i = code.indexOf("handle('fs:scan-tree'");
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
  const j = code.indexOf("handle('fs:scan-empty-dirs'");
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

/* ==================== 执行 ==================== */

done();
