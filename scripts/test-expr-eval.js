'use strict';
/* 安全表达式求值器回归。
 *
 * 背景：原科学计算器用 Function('return (...)')() 求值，为此整站 CSP 开了
 * script-src 'unsafe-eval'。现在改为递归下降解析器，可以彻底去掉 unsafe-eval。
 *
 * 本测试要保证两件事：
 *   1) 原计算器支持的所有写法都还能算（不能因为安全化而砍功能）
 *   2) 任何「试图执行代码」的输入都必须报错，而不是被执行
 */
const assert = require('assert');
const ev = require('../lib/expr-eval');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('PASS  ' + n); } catch (e) { fail++; console.log('FAIL  ' + n + '  -> ' + e.message); } };

/* ---- 1. 基础运算 ---- */
t('四则运算与优先级', () => {
  assert.strictEqual(ev.evaluate('1+2'), 3);
  assert.strictEqual(ev.evaluate('2+3*4'), 14);
  assert.strictEqual(ev.evaluate('(2+3)*4'), 20);
  assert.strictEqual(ev.evaluate('10/4'), 2.5);
  assert.strictEqual(ev.evaluate('10%3'), 1);        // 取余
  assert.strictEqual(ev.evaluate('2-3-4'), -5);      // 左结合
  assert.strictEqual(ev.evaluate('10/2/5'), 1);
});

t('幂运算（^ 与 ** 都支持，右结合）', () => {
  assert.strictEqual(ev.evaluate('2^10'), 1024);
  assert.strictEqual(ev.evaluate('2**10'), 1024);
  assert.strictEqual(ev.evaluate('2^3^2'), 512);     // 右结合 = 2^(3^2)
  assert.strictEqual(ev.evaluate('2**(3)'), 8);
});

t('一元正负', () => {
  assert.strictEqual(ev.evaluate('-5'), -5);
  assert.strictEqual(ev.evaluate('3+-2'), 1);
  assert.strictEqual(ev.evaluate('-(2+3)'), -5);
  assert.strictEqual(ev.evaluate('+7'), 7);
});

/* ---- 2. 函数与常量（原计算器的字符按钮都能用） ---- */
t('三角函数与常量', () => {
  const r = ev.evaluate('sin(pi/4)');
  assert.ok(Math.abs(r - Math.sin(Math.PI / 4)) < 1e-12, 'sin(pi/4) 值不对: ' + r);
  assert.ok(Math.abs(ev.evaluate('cos(0)') - 1) < 1e-12);
  assert.ok(Math.abs(ev.evaluate('tan(0)')) < 1e-12);
  assert.ok(Math.abs(ev.evaluate('e') - Math.E) < 1e-12);
  assert.ok(Math.abs(ev.evaluate('pi') - Math.PI) < 1e-12);
});

t('对数、平方根、绝对值', () => {
  assert.strictEqual(ev.evaluate('log10(100)'), 2);
  assert.strictEqual(ev.evaluate('log(100)'), 2);
  assert.ok(Math.abs(ev.evaluate('ln(e)') - 1) < 1e-12);
  assert.strictEqual(ev.evaluate('sqrt(16)'), 4);
  assert.strictEqual(ev.evaluate('abs(-3)'), 3);
});

t('取整函数', () => {
  assert.strictEqual(ev.evaluate('ceil(1.2)'), 2);
  assert.strictEqual(ev.evaluate('floor(1.8)'), 1);
  assert.strictEqual(ev.evaluate('round(1.5)'), 2);
});

t('百分号后缀：50% → 0.5', () => {
  assert.strictEqual(ev.evaluate('50%'), 0.5);
  assert.strictEqual(ev.evaluate('200*10%'), 20);
});

t('原界面按钮的写法都能算（sin(pi/4)+2^10*1.5）', () => {
  const r = ev.evaluate('sin(pi/4)+2^10*1.5');
  const want = Math.sin(Math.PI / 4) + 1024 * 1.5;
  assert.ok(Math.abs(r - want) < 1e-9, '结果不符: ' + r + ' vs ' + want);
});

t('全角 × ÷ 与中文逗号也被归一', () => {
  assert.strictEqual(ev.evaluate('3×4'), 12);
  assert.strictEqual(ev.evaluate('8÷2'), 4);
});

t('科学计数法', () => {
  assert.strictEqual(ev.evaluate('1e3'), 1000);
  assert.strictEqual(ev.evaluate('1.5e-2'), 0.015);
});

/* ---- 3. 安全：任何代码执行尝试都必须报错 ---- */
t('拒绝访问全局对象', () => {
  for (const bad of [
    'document.cookie', 'window.location', 'globalThis',
    'constructor', 'this', 'prototype', '__proto__',
    'process.env', 'require("fs")', 'eval("1")', 'Function("return 1")()',
    'alert(1)', 'fetch("/x")', 'localStorage'
  ]) {
    assert.throws(() => ev.evaluate(bad), /不支持/, '该输入应被拒绝: ' + bad);
  }
});

t('拒绝字符串与模板字面量', () => {
  for (const bad of ['"abc"', "'abc'", '`${1}`', '[1,2]', '{a:1}', 'x=>x']) {
    assert.throws(() => ev.evaluate(bad), /不支持/, '该输入应被拒绝: ' + bad);
  }
});

t('拒绝 Math.constructor 这类链条（旧实现的漏洞点）', () => {
  assert.throws(() => ev.evaluate('Math.constructor'), /不支持/);
  assert.throws(() => ev.evaluate('Math["constructor"]'), /不支持/);
  assert.throws(() => ev.evaluate('Math.toString'), /不支持/);
});

t('拒绝赋值与逗号表达式', () => {
  for (const bad of ['a=1', '1,2', 'let x=1']) {
    assert.throws(() => ev.evaluate(bad), /不支持/, '该输入应被拒绝: ' + bad);
  }
});

t('括号/表达式不完整要报错而不是返回垃圾值', () => {
  for (const bad of ['1+', '(1+2', 'sin', 'sin(', ')', '1 2']) {
    assert.throws(() => ev.evaluate(bad), /Error|不完整|无效|不匹配|多余|括号/);
  }
});

/* ---- 4. 实现本身不含 eval ---- */
t('实现源码里没有 eval / Function 构造', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'expr-eval.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/\beval\s*\(/.test(code), '实现里仍有 eval(');
  assert.ok(!/new\s+Function/.test(code), '实现里仍有 new Function');
});

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
