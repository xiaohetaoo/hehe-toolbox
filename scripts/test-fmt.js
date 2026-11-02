'use strict';
const assert = require('assert');
const { t, done } = require('./lib/harness');

/* 格式化助手的行为测试（原 test-round13 的 16a）。
 *
 * 锁的是：fmtBytes(null) 会输出 "null B" —— 缺值时应该显示 - 或空，
 * 而不是一个看着像真实体积的字符串。 */

/* ------------ 以下为迁移来的用例（断言逐字保留） ------------ */

/* ---------------- 以下助手随 round13 的用例一起迁来 ----------------
 * 都从主进程/渲染层源码里抽出**真实现**来跑，不是手写副本
 * （副本会与实现分叉，那样测试就假绿了）。 */
const TS = require('../lib/target-size');

t('16a fmtBytes：null/undefined 不能变成 "null B"', () => {
  /* 原实现 `if (!(n >= 0)) return '-'`，而 null >= 0 为 true，
   * 于是 fmtBytes(null) 一路走到 `n < 1024` 返回字符串 "null B"。 */
  for (const v of [null, undefined, NaN, Infinity, -Infinity, -1]) {
    const s = TS.fmtBytes(v);
    assert.strictEqual(s, '-', 'fmtBytes(' + String(v) + ') 应为 "-"，实际 "' + s + '"');
  }
  /* 0 是合法值（空文件），不能被当成"没有" */
  assert.strictEqual(TS.fmtBytes(0), '0 B', '0 字节应显示 "0 B"');
  assert.strictEqual(TS.fmtBytes(1023), '1023 B');
  assert.strictEqual(TS.fmtBytes(1024), '1.0 KB');
});

done();
