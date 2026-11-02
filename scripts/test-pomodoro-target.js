'use strict';
const { t, done } = require('./lib/harness');
/* 番茄钟目标数的行为测试（原 test-round15 的 12a）。
 *
 * 锁的是：目标番茄数输入框创建后**从未被读取** —— 用户改了数字，
 * 「已完成」那一行永远停在初始值。no-unused-vars 能直接指出这个形态
 * （countIn 创建后从未读取）。 */

/* ------------ 以下为迁移来的用例（断言逐字保留） ------------ */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const stripComments = require('../lib/src-scan').stripComments;
function read(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }

t('12a countIn 被读取，「已完成」可刷新', () => {
  const code = stripComments(read('js/tools/life.js'));
  /* 锁的是：「12a countIn 被读取，「已完成」可刷新」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/function readTarget/.test(code), '没有读取目标番茄数');
  /* 锁的是：「12a countIn 被读取，「已完成」可刷新」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/parseInt\(countIn\.value/.test(code), 'countIn 仍然从没被读过');
  /* 锁的是：「12a countIn 被读取，「已完成」可刷新」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/targetPomodoros = Math\.max/.test(code), '没有做范围钳制');
  /* 锁的是：「12a countIn 被读取，「已完成」可刷新」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/paintDone/.test(code), '「已完成」没有可刷新的绘制函数');
  /* 锁的是：「12a countIn 被读取，「已完成」可刷新」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/countIn\.addEventListener\('change'/.test(code), '改目标后界面不更新');
  /* 反面：不能再是一次性文本 */
  /* 锁的是：「12a countIn 被读取，「已完成」可刷新」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(!/h\('span', \{ class: 'field-hint' \}, `已完成 \$\{pomodoros\}`\)/.test(code),
    '「已完成」仍是一次性字符串（永远是 0）');
});

/* ==================== 13. split-file 的失败收口 ==================== */

done();
