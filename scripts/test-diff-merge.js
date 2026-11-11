'use strict';
/* 三栏对比的「合并模式」结果拼装（js/tools/diff3.js 的 buildText）。
 *
 * ============ 锁的是哪次事故 / 哪个决策 ============
 * 用户要求做「可编辑合并」。核心不是 UI，而是**拼装结果对不对**：
 *   · 某一方没有这一行（null）必须跳过，不能塞空字符串 —— 否则结果里
 *     会出现原文没有的空行；
 *   · "删除"要真的不输出；
 *   · 缩进与行尾空白必须原样保留 —— 合并代码时缩进错了等于结果错了；
 *   · **空字符串行是有意义的行**，不能被当成"缺失"跳过。
 *
 * ============ 为什么用"复刻 + 源码一致性断言"而不是直接 require ============
 * js/tools/diff3.js 是浏览器 IIFE，require 会立刻 ReferenceError
 * （没有 window.Registry）。而 buildText 依赖闭包里的 rows/choice 两个变量，
 * 没法单独抽出来。所以复刻这 8 行逻辑，并用源码断言强制它与真实实现一致 ——
 * 这样复刻不会悄悄分叉成"测一份过时副本"。
 */
const assert = require('assert');
/* 读源码走 readSrc（元测试 SA-3 强制）：
 * 它会剥注释，避免注释里引用的示例代码被误命中。 */

const { t, done, readSrc } = require('./lib/harness');

/** 复刻 buildText：从 rows + choice 拼出结果文本。 */
function buildFrom(rows, choice) {
  const out = [];
  for (const r of rows) {
    const c = choice.get(r.i);
    if (c === 'none') continue;
    const v = c === 'a' ? r.a : (c === 'b' ? r.b : r.base);
    if (v == null) continue;
    out.push(v);
  }
  return out.join('\n');
}

t('DM1 按选择拼装（A 侧取 A、B 侧取 B、基准侧取基准）', () => {
  const rows = [
    { i: 0, kind: 'same', base: '不变', a: '不变', b: '不变' },
    { i: 1, kind: 'a', base: '原A', a: '新A', b: '原A' },
    { i: 2, kind: 'b', base: '原B', a: '原B', b: '新B' },
  ];
  const c = new Map([[0, 'base'], [1, 'a'], [2, 'b']]);
  /* 锁的是：选边被忽略（永远取某一侧）—— 合并结果与用户点的不一致。 */
  assert.strictEqual(buildFrom(rows, c), '不变\n新A\n新B');
});

t('DM2 选中 null 的行被跳过，不产生空行', () => {
  const rows = [
    { i: 0, kind: 'miss', base: 'x', a: null, b: 'x' },
    { i: 1, kind: 'miss', base: 'y', a: 'y', b: null },
  ];
  /* 锁的是：把 null 转成空串塞进结果 —— 原文没有的空行会凭空出现，
   * 对代码文件来说那是语法错误。 */
  assert.strictEqual(buildFrom(rows, new Map([[0, 'a'], [1, 'b']])), '');

  const c2 = new Map([[0, 'base'], [1, 'base']]);
  assert.strictEqual(buildFrom(rows, c2), 'x\ny', '改选基准后两行都应在');
});

t('DM3 选「删除」的行真的不输出', () => {
  const rows = [
    { i: 0, kind: 'base-only', base: '要删的', a: null, b: null },
    { i: 1, kind: 'same', base: '留着', a: '留着', b: '留着' },
  ];
  /* 锁的是：删除选项失效 —— 用户选了删但结果里还留着。 */
  assert.strictEqual(buildFrom(rows, new Map([[0, 'none'], [1, 'base']])), '留着');
});

t('DM4 缩进与行尾空白原样保留', () => {
  const rows = [{ i: 0, kind: 'a', base: '  old', a: '    indented  ', b: '  old' }];
  /* 锁的是：对行内容做了 trim —— 合并代码时缩进错位，结果不能用。 */
  assert.strictEqual(buildFrom(rows, new Map([[0, 'a']])), '    indented  ');
});

t('DM5 空字符串行是有意义的行，不能被当成缺失跳过', () => {
  const rows = [
    { i: 0, kind: 'same', base: '', a: '', b: '' },
    { i: 1, kind: 'same', base: 'x', a: 'x', b: 'x' },
  ];
  /* 锁的是：用 `if (!v) continue` 判空 —— 那会把空行和 null 混为一谈，
   * 原文的空行全被吃掉。 */
  assert.strictEqual(buildFrom(rows, new Map([[0, 'base'], [1, 'base']])), '\nx');
});

t('DM6 真实实现里必须有对应的三条判据（防复刻分叉）', () => {
  const src = readSrc('js/tools/diff3.js');
  /* 锁的是：真实实现的拼装逻辑被改（删了 null 判断、或改成 push(v || '')），
   * 而这里复刻没跟上 —— 那样本文件的用例就成了测一份过时的副本，
   * 永远绿但毫无意义。 */
  assert.ok(src.includes('if (v == null) continue;'),
    '真实实现里缺少 null 跳过判断');
  /* 锁的是：删除判据被删 —— 用户选了「删除」但结果里还留着那一行。 */
  assert.ok(src.includes("if (c === 'none') continue;"),
    '真实实现里缺少删除判断');
  /* 锁的是：null 被兜底成空串 —— 会凭空产生原文没有的空行。 */
  assert.ok(!/push\(v \|\| ''\)/.test(src),
    '真实实现把 null 转成了空串（会凭空产生空行）');
  /* 锁的是：合并模式被整体移除而测试还在跑空转的复刻。 */
  assert.ok(/function enterMerge\(/.test(src), '真实实现里没有 enterMerge');
});

t('DM7 默认选择策略：只有一方改才自动采信，冲突一律留给用户', () => {
  const src = readSrc('js/tools/diff3.js');
  const seg = src.slice(src.indexOf('function enterMerge('), src.indexOf('function enterMerge(') + 2200);
  /* 锁的是："冲突行"被自动选成某一侧 —— 那是替用户做决定，
   * 合并结果可能悄悄丢了一方的改动。 */
  assert.ok(/r\.kind === 'both'[\s\S]{0,80}'base'/.test(seg) || /else choice\.set\(r\.i, 'base'\)/.test(seg),
    '冲突行的默认选择应回落到基准（不自动采信任何一方）');
  /* 锁的是："只有 A 改"这类无争议行没被自动采信（用户得逐行点，体验差且易漏） */
  assert.ok(/r\.kind === 'a'\) choice\.set\(r\.i, 'a'\)/.test(seg),
    '「仅 A 改」的行应自动选 A');
  assert.ok(/r\.kind === 'b'\) choice\.set\(r\.i, 'b'\)/.test(seg),
    '「仅 B 改」的行应自动选 B');
});

done();
