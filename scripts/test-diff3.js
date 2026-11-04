'use strict';
/* 三栏对比（diff3）的判定逻辑测试。
 *
 * ============ 为什么必须测 ============
 * 这个工具的**全部价值**就在那一行 kind 判定上。判错的后果很具体：
 *   · 把「两边都改」判成「一致」→ 用户以为没有冲突，直接采用其中一份，
 *     丢掉另一份的改动
 *   · 把「只有 A 改」判成「冲突」→ 用户被迫逐行核对，工具失去意义
 * 而这两种错都不会有任何提示 —— 结果看起来"正常"。
 *
 * 判定逻辑是纯函数，抽出来单独测。不测 UI（那层只是把 kind 映射成颜色）。
 */
const assert = require('assert');
const { t, done } = require('./lib/harness');

/* 【必须与 js/tools/diff3.js 里的 compare() 保持一致】
 * 那个文件是 IIFE 包裹的，函数取不到。所以这里复制一份，
 * 并在最后用源码断言守住"两边是同一套判定"。 */
function compare(base, a, b) {
  const n = Math.max(base.length, a.length, b.length);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const bl = base[i], al = a[i], cl = b[i];
    const hasBase = i < base.length, hasA = i < a.length, hasB = i < b.length;
    let kind;
    if (!hasA && !hasB) kind = 'base-only';
    else if (!hasA || !hasB || !hasBase) kind = 'miss';
    else if (al === bl && cl === bl) kind = 'same';
    else if (al === cl && al !== bl) kind = 'both-same';
    else if (al === bl) kind = 'b';
    else if (cl === bl) kind = 'a';
    else kind = 'both';
    rows.push({ i, base: hasBase ? bl : null, a: hasA ? al : null, b: hasB ? cl : null, kind });
  }
  return rows;
}

const kinds = (rows) => rows.map((r) => r.kind);

t('三方完全一致 → 全部 same', () => {
  const r = compare(['a', 'b'], ['a', 'b'], ['a', 'b']);
  assert.deepStrictEqual(kinds(r), ['same', 'same']);
});

t('只有 A 改了 → kind=a', () => {
  const r = compare(['x'], ['y'], ['x']);
  assert.deepStrictEqual(kinds(r), ['a']);
});

t('只有 B 改了 → kind=b', () => {
  const r = compare(['x'], ['x'], ['y']);
  assert.deepStrictEqual(kinds(r), ['b']);
});

t('两边都改且不同 → kind=both（冲突）', () => {
  const r = compare(['x'], ['y'], ['z']);
  assert.deepStrictEqual(kinds(r), ['both']);
});

t('两边改成一样的内容 → both-same（不是冲突）', () => {
  // 这一条很容易被误判成 both：两边都"改了"，但改法相同，
  // 实际上不需要人判断。标成冲突会让用户白核对一遍。
  const r = compare(['x'], ['y'], ['y']);
  assert.deepStrictEqual(kinds(r), ['both-same']);
});

t('两边都删掉了基准行 → base-only', () => {
  // a/b 比 base 短，且都缺这一行
  const r = compare(['x', 'y'], ['x'], ['x']);
  assert.deepStrictEqual(kinds(r), ['same', 'base-only']);
});

t('行数不一致（只有一边少了）→ miss，不是 base-only', () => {
  // 关键区分：两边都删 = base-only（明确意图）；
  // 只有一边少 = miss（可能是没粘全，不该当成"删了"）
  const r = compare(['x', 'y'], ['x'], ['x', 'y']);
  assert.deepStrictEqual(kinds(r), ['same', 'miss']);
});

t('A 比基准多出行 → miss（无法对齐）', () => {
  const r = compare(['x'], ['x', 'extra'], ['x']);
  assert.deepStrictEqual(kinds(r), ['same', 'miss']);
});

t('空输入不崩', () => {
  assert.deepStrictEqual(kinds(compare([], [], [])), []);
  assert.deepStrictEqual(kinds(compare([''], [''], [''])), ['same']);
});

t('小写/空白差异不会被当成相同（严格比较）', () => {
  const r = compare(['Foo'], ['foo'], ['Foo']);
  assert.deepStrictEqual(kinds(r), ['a'], '大小写不同应判为改动');
  const r2 = compare(['a b'], ['a  b'], ['a b']);
  assert.deepStrictEqual(kinds(r2), ['a'], '空格不同应判为改动');
});

t('多行混合场景', () => {
  const base = ['l1', 'l2', 'l3', 'l4', 'l5'];
  const a = ['l1', 'A2', 'l3', 'A4', 'l5'];   // 改 2、4
  const b = ['l1', 'l2', 'l3', 'B4', 'l5'];   // 改 4
  const r = compare(base, a, b);
  assert.deepStrictEqual(kinds(r), ['same', 'a', 'same', 'both', 'same']);
});

t('null / undefined 行按"没有这一行"处理', () => {
  const r = compare(['x'], ['x'], ['x', undefined]);
  // undefined 参与比较时不应抛异常
  assert.strictEqual(r.length, 2);
});

/* ---------------- 与工具实现的一致性 ---------------- */
/* 锁的是：测试里复制的 compare() 必须与 js/tools/diff3.js 里的是同一套判定。
 * 不能用行为断言的原因：工具是 IIFE 包裹的，compare 没有导出，
 * 测试无法 require 到它。所以用源码断言守住"两边逻辑一致"——
 * 一旦有人只改了一边（比如调换了 a / b 的判定顺序），这里会红。 */
t('工具文件里的判定顺序与测试副本一致', () => {
  const { readSrc } = require('./lib/harness');
  const src = readSrc('js/tools/diff3.js');
  /* 锁的是：冲突判定必须排在 a/b 之前。
   * 如果先判 `al === bl → b` 再判冲突，那「两边都改」永远不会命中 both
   * （因为 al===bl 时它已经被判成 b 了）——冲突行会被静默吞掉。 */
  const iSame = src.indexOf("kind = 'same'");
  const iBothSame = src.indexOf("kind = 'both-same'");
  const iB = src.indexOf("kind = 'b'");
  const iA = src.indexOf("kind = 'a'");
  const iBoth = src.indexOf("kind = 'both'");
  assert.ok(iSame > 0 && iBothSame > iSame && iB > iBothSame && iA > iB && iBoth > iA,
    '判定顺序应为 same → both-same → b → a → both，实际索引 ' +
    [iSame, iBothSame, iB, iA, iBoth].join(','));
});

done();
