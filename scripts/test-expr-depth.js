'use strict';
/* 科学计算器：深嵌套表达式要给中文原因，而不是英文栈溢出或一句"表达式有误"。
 *
 * ============ 锁的是哪个回归 ============
 * lib/expr-eval.js 是递归下降解析器，每层括号/函数/一元符号都是一次真递归。
 * 超深时 V8 抛 `RangeError: Maximum call stack size exceeded`，而两条下游都把它丢掉：
 *   ① preload 的 evalExpr 只把 e.message 回传（英文原文）；
 *   ② js/tools/convert.js 的 catch 只放行含「不允许」的 message，
 *      其它一律显示「⚠ 表达式有误」。
 * 实测输入与结果：
 *   '(' × 5000 + '1' + ')' × 5000       → 「表达式有误」（什么都看不出）
 *   'sqrt(' × 3000 + '16' + ')' × 3000  → 「表达式有误」
 *   '-' × 20000 + '1'                   → 「表达式有误」
 * 用户既不知道是"太深"、也不知道可以分层算。
 *
 * ============ 修法的边界（这一条最要紧） ============
 * 第一版试过在进入递归前判个固定上限（MAX_DEPTH = 1000）。它**收窄了能力**：
 * 实测 1500 层括号本来算得出来，加了上限反而报错。那是改行为，不是修文案。
 * 最终做法是兜底：照原样算，只有真溢出时才把英文换成中文。
 * 所以下面同时锁两件事 —— 能算的必须还能算、算不了的说中文。
 */
const assert = require('assert');
const { t, done, readSrc } = require('./lib/harness');

const ev = require('../lib/expr-eval');

/* ============ 能力不能被收窄 ============ */
t('ED1 原本算得出来的深嵌套必须还能算（不能为了报错就砍范围）', () => {
  /* 这三个深度是实测过的**安全区**（真机 Node 24 / V8 上能算出来）。
   * 锁的是：加了一个"看起来合理"的深度上限（比如 1000）把这些一起拒了 ——
   * 那是收窄用户可见行为，不是修文案。 */
  assert.strictEqual(ev.evaluate('('.repeat(1500) + '1' + ')'.repeat(1500)), 1,
    '1500 层括号算不出来了 —— 加深度上限把正常能力砍掉了');
  assert.strictEqual(ev.evaluate('sqrt('.repeat(800) + '16' + ')'.repeat(800)), 1,
    '800 层 sqrt 算不出来了');
  assert.strictEqual(ev.evaluate('-'.repeat(5000) + '1'), 1,
    '5000 个一元负号算不出来了');
});

t('ED2 真的溢出时给中文提示（不是英文栈溢出）', () => {
  /* 锁的是：直接把 RangeError 的英文原文透给用户 ——
   * 中文界面里出现 "Maximum call stack size exceeded"。 */
  const cases = [
    '('.repeat(5000) + '1' + ')'.repeat(5000),
    'sqrt('.repeat(3000) + '16' + ')'.repeat(3000),
    '-'.repeat(20000) + '1',
  ];
  for (const e of cases) {
    let msg = null;
    try { ev.evaluate(e); } catch (err) { msg = err.message; }
    /* 锁的是：溢出被静默吞掉（返回 NaN / undefined）—— 用户拿到一个假结果。 */
    assert.ok(msg, '这条超深表达式居然"算成功"了，没有报错');
    /* 锁的是：透出英文原文。 */
    assert.ok(!/call stack|Maximum/i.test(msg), '仍是英文栈溢出：' + msg);
    /* 锁的是：只写「无法计算」不说原因 —— 用户不知道是深度问题。 */
    assert.ok(/嵌套|太深/.test(msg), '提示没有点出是嵌套太深：' + msg);
  }
});

t('ED3 深度报错用 Error 而不是 RangeError（下游按普通错误处理）', () => {
  /* 锁的是：把 RangeError 原样抛出去 —— 调用方（preload / 渲染层）
   * 对 RangeError 没有专门处理，它的 name 会漏到界面上。 */
  let caught = null;
  try { ev.evaluate('('.repeat(5000) + '1' + ')'.repeat(5000)); } catch (err) { caught = err; }
  assert.ok(caught, '应该抛错');
  assert.strictEqual(caught.name, 'Error', '深度错误仍是 ' + caught.name);
});

/* ============ 不能误伤正常错误 ============ */
t('ED4 语法错误仍然给出原文（不要把所有错误都改成"嵌套太深"）', () => {
  /* 锁的是：兜底捕获写得太宽 —— `catch (e) { throw new Error('嵌套太深') }`
   * 这种写法会把语法错、未知函数全说成深度问题，比原来更难排查。 */
  const cases = [
    ['1+', '表达式不完整'],
    ['foo(1)', '不支持'],
    ['(1+2', '括号'],
    ['1/0', '无法计算'],
  ];
  for (const [expr, want] of cases) {
    let msg = null;
    try { ev.evaluate(expr); } catch (err) { msg = err.message; }
    assert.ok(msg, expr + ' 应该报错');
    /* 锁的是：非溢出错误被统一改写成"嵌套太深"。 */
    assert.ok(!/嵌套太深/.test(msg), expr + ' 被误报成嵌套太深：' + msg);
    assert.ok(new RegExp(want).test(msg), expr + ' 的报错不对：' + msg);
  }
});

t('ED5 正常表达式结果不变（回归面最大）', () => {
  /* 锁的是：为了包 try/catch 把求值结果/顺序改坏了。 */
  assert.strictEqual(ev.evaluate('1+2'), 3);
  assert.strictEqual(ev.evaluate('(2+3)*4'), 20);
  assert.strictEqual(ev.evaluate('2^3^2'), 512);
  assert.strictEqual(ev.evaluate('50%'), 0.5);
  assert.strictEqual(ev.evaluate('sqrt(sqrt(sqrt(16)))'), Math.SQRT2);
  assert.strictEqual(ev.evaluate('sin(pi/4)').toFixed(6), Math.sin(Math.PI / 4).toFixed(6));
});

/* ============ 界面这一层 ============ */
t('ED6 计算器界面要透出「嵌套太深」这类可操作提示', () => {
  const src = readSrc('js/tools/convert.js');
  /* 锁的是：catch 只放行含「不允许」的那一种，其它一律显示「表达式有误」——
   * 于是"嵌套太深"这种能照着做的提示被吞掉。 */
  assert.ok(/嵌套太深/.test(src), '界面的放行名单里没有「嵌套太深」');
  /* 锁的是：把语法错也一起透出 —— parser 的语法提示对普通用户太细。 */
  assert.ok(/表达式有误/.test(src), '通用兜底文案被删掉了');
});

done();
