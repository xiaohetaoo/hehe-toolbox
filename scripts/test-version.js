'use strict';
const { t, done, readMain } = require('./lib/harness');
/* 主进程源码：迁移来的 cmpVer 用例要把真实现从里面抽出来跑。 */
const mainSrc = readMain({ raw: true });
/* 版本号进位规则：每段 0–9，满 10 向前进位。
 * 用户明确要求：以后版本号每过 10 都要向前进位。 */
const assert = require('assert');
const { normalize, isValid, parse, bump, fmt } = require('./version');

/* ---------------- 以下助手随 round13 的用例一起迁来 ----------------
 * loadCmpVer：把 cmpVer 的实现从源码里抽出来求值 ——
 * 它是**真实现**，不是手写副本（副本会与实现分叉，那样测试就假绿了）。 */



function loadCmpVer() {
  const i = mainSrc.indexOf('function cmpVer');
  const j = mainSrc.indexOf('\n}', i) + 2;
  return new Function(mainSrc.slice(i, j) + '\nreturn cmpVer;')();
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

t('5a cmpVer：带 -beta / -rc1 后缀的版本号不能被判成「更旧」', () => {
  const cmpVer = loadCmpVer();
  assert.strictEqual(cmpVer('0.3.5-beta', '0.3.4'), 1,
    '预发布版仍比上一版新；原实现返回 -4（NaN 参与运算）');
  assert.strictEqual(cmpVer('0.4.0-rc1', '0.3.9'), 1);
  assert.strictEqual(cmpVer('0.3.5-beta', '0.3.5'), 0, '同一版本号的不同标记应视为相等');
});

t('5b cmpVer：三态语义（只返回 -1/0/1），且常规比较不变', () => {
  const cmpVer = loadCmpVer();
  const table = [
    ['0.3.5', '0.3.4', 1], ['0.3.4', '0.3.5', -1], ['0.3.5', '0.3.5', 0],
    ['0.3.10', '0.3.9', 1], ['0.0.9', '0.0.10', -1], ['1.0.0', '0.9.9', 1],
    ['v0.3.5', '0.3.4', 1],
  ];
  for (const [a, b, want] of table) {
    assert.strictEqual(cmpVer(a, b), want, 'cmpVer(' + a + ', ' + b + ') 应为 ' + want);
  }
});

t('5c cmpVer：无法解析的输入不抛异常，按 0 处理', () => {
  const cmpVer = loadCmpVer();
  assert.doesNotThrow(() => cmpVer('', '0.3.5'));
  assert.doesNotThrow(() => cmpVer('abc', undefined));
  assert.strictEqual(cmpVer('abc', '0.0.0'), 0, '解析不出来时按 0 比较，不能是 NaN');
});

/* ==================== 6. 数据文件损坏时不能静默覆盖 ==================== */

done();
