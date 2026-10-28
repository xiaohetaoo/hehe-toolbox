'use strict';
/* 版本号进位规则：每段 0–9，满 10 向前进位。
 * 用户明确要求：以后版本号每过 10 都要向前进位。 */
const assert = require('assert');
const { normalize, isValid, parse, bump, fmt } = require('./version');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '  -> ' + e.message); }
}

t('合规版本号被接受', () => {
  for (const v of ['0.0.1', '0.1.4', '1.0.0', '9.9.9']) {
    assert.ok(isValid(parse(v)), v + ' 应合规');
  }
});

t('某段 >=10 判为不合规', () => {
  for (const v of ['0.0.14', '0.0.10', '0.10.1', '10.0.0']) {
    assert.ok(!isValid(parse(v)), v + ' 应不合规');
  }
});

t('进位：末位满 10 进中位', () => {
  assert.strictEqual(fmt(normalize([0, 0, 14])), '0.1.4');
  assert.strictEqual(fmt(normalize([0, 0, 10])), '0.1.0');
  // 补丁位 99 = 9 个十 + 9 个一 → 进 9 到中位 → 0.9.9（总值 99）
  assert.strictEqual(fmt(normalize([0, 0, 99])), '0.9.9');
  // 补丁位 100 = 10 个十 → 中位 +10 → 再进高位 → 1.0.0（总值 100）
  assert.strictEqual(fmt(normalize([0, 0, 100])), '1.0.0');
});

t('进位：中位满 10 进高位', () => {
  assert.strictEqual(fmt(normalize([0, 10, 0])), '1.0.0');
  assert.strictEqual(fmt(normalize([0, 12, 3])), '1.2.3');
});

t('进位：连锁进位', () => {
  // 0.9.10 -> 末位 10 进中位 -> 0.10.0 -> 中位 10 进高位 -> 1.0.0
  assert.strictEqual(fmt(normalize([0, 9, 10])), '1.0.0');
});

t('合规版本号 normalize 保持原样', () => {
  for (const [inp, want] of [[[0, 1, 4], '0.1.4'], [[1, 0, 0], '1.0.0'], [[9, 9, 9], '9.9.9']]) {
    assert.strictEqual(fmt(normalize(inp)), want);
  }
});

t('bump 递增并按规则进位', () => {
  assert.strictEqual(fmt(bump([0, 0, 9])), '0.1.0', '0.0.9 +1 => 0.1.0');
  assert.strictEqual(fmt(bump([0, 1, 9])), '0.2.0', '0.1.9 +1 => 0.2.0');
  assert.strictEqual(fmt(bump([0, 9, 9])), '1.0.0', '0.9.9 +1 => 1.0.0');
  assert.strictEqual(fmt(bump([0, 1, 4])), '0.1.5', '0.1.4 +1 => 0.1.5');
  assert.strictEqual(fmt(bump([0, 0, 14])), '0.1.5', '旧写法的 0.0.14 +1 => 0.1.5');
});

t('非法输入返回 null', () => {
  for (const v of ['', 'abc', '1.2', '1.2.3.4', '1.2.x', null, undefined]) {
    assert.strictEqual(parse(v), null, String(v) + ' 应解析失败');
  }
});

t('package.json 当前版本合规', () => {
  const v = require('../package.json').version;
  assert.ok(isValid(parse(v)), `package.json version=${v} 不合规，应按规则进位`);
});

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
