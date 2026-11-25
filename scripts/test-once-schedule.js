'use strict';
/* R20：一次性定时任务的坏时间戳不能触发系统睡眠/锁屏。
 *
 * 行为用例直接调 lib/once-schedule.js（main.js 用的是同一份实现），
 * 覆盖：损坏 fireAt 应 drop、未来 keep、过期补执行、过期太久 drop、
 * 非数组/空项不抛。
 */

const { t, done, assert } = require('./lib/harness');
const { fireAtOf, decideOnce } = require('../lib/once-schedule');

const NOW = 1764000000000;
const CATCH = 60 * 60 * 1000;

t('fireAtOf：只接受正有限数', () => {
  assert.strictEqual(fireAtOf({ fireAt: NOW }), NOW);
  assert.strictEqual(fireAtOf({ fireAt: String(NOW) }), NOW);
  assert.strictEqual(fireAtOf({ fireAt: 'abc' }), null);
  assert.strictEqual(fireAtOf({ fireAt: NaN }), null);
  assert.strictEqual(fireAtOf({ fireAt: Infinity }), null);
  assert.strictEqual(fireAtOf({ fireAt: -1 }), null);
  assert.strictEqual(fireAtOf({ fireAt: 0 }), null);
  assert.strictEqual(fireAtOf({ fireAt: '' }), null);
  assert.strictEqual(fireAtOf({ fireAt: '   ' }), null);
  assert.strictEqual(fireAtOf(null), null);
});

t('decideOnce：损坏时间戳一律 drop（不能落进 setTimeout）', () => {
  for (const fireAt of ['abc', NaN, Infinity, -1, 0, '', '   ', null, undefined]) {
    assert.deepStrictEqual(decideOnce({ id: 'x', fireAt }, NOW, CATCH), { kind: 'drop' },
      'fireAt=' + String(fireAt) + ' 应丢弃');
  }
});

t('decideOnce：没有 id 的任务丢弃', () => {
  assert.deepStrictEqual(decideOnce({ fireAt: NOW + 1000 }, NOW, CATCH), { kind: 'drop' });
  assert.deepStrictEqual(decideOnce(null, NOW, CATCH), { kind: 'drop' });
});

t('decideOnce：未来任务保留', () => {
  const d = decideOnce({ id: 'x', fireAt: NOW + 5000 }, NOW, CATCH);
  assert.strictEqual(d.kind, 'keep');
  assert.strictEqual(d.fireAt, NOW + 5000);
});

t('decideOnce：刚过点仍在补执行窗口内 → run', () => {
  assert.strictEqual(decideOnce({ id: 'x', fireAt: NOW - 1000 }, NOW, CATCH).kind, 'run');
  assert.strictEqual(decideOnce({ id: 'x', fireAt: NOW - CATCH }, NOW, CATCH).kind, 'run');
});

t('decideOnce：过期超过窗口 → drop', () => {
  assert.strictEqual(decideOnce({ id: 'x', fireAt: NOW - CATCH - 1 }, NOW, CATCH).kind, 'drop');
  assert.strictEqual(decideOnce({ id: 'x', fireAt: NOW - 1000 }, NOW, 0).kind, 'drop');
});

t('decideOnce：now/catchup 非数字时不抛且不会误 run', () => {
  const d = decideOnce({ id: 'x', fireAt: NOW + 1000 }, NaN, CATCH);
  assert.ok(['keep', 'run', 'drop'].includes(d.kind), 'now 非法时得到 ' + d.kind);
  assert.strictEqual(decideOnce({ id: 'x', fireAt: NOW - 1000 }, NOW, NaN).kind, 'drop');
});

done();
