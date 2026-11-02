'use strict';
const { t, done } = require('./lib/harness');
/* 随机数/随机字符串输入框的行为测试（原 test-round15 的 11a / 11b）。
 *
 * 锁的是：两个功能共用同一个 input 元素，于是「随机数字」的长度
 * 会跟着「随机字符串」的滑块变。用户改一个、另一个跟着变，看着像 bug。 */

/* ------------ 以下为迁移来的用例（断言逐字保留） ------------ */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const stripComments = require('../lib/src-scan').stripComments;
function read(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }

t('11a 长度用独立的 lenIn，rangeA 只出现一次', () => {
  const code = stripComments(read('js/tools/dev.js'));
  /* 锁的是：「11a 长度用独立的 lenIn，rangeA 只出现一次」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/const lenIn = h\('input'/.test(code), '没有独立的长度输入框');
  const i = code.indexOf("div('card', div('card-title', '生成')");
  const seg = code.slice(i, i + 500);
  /* 锁的是：「11a 长度用独立的 lenIn，rangeA 只出现一次」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  const count = (seg.match(/rangeA/g) || []).length;
  assert.strictEqual(count, 1, 'rangeA 在「生成」卡片里出现了 ' + count + ' 次（DOM 节点只能有一个父节点，第二次 append 会把它移走）');
  /* 锁的是：「11a 长度用独立的 lenIn，rangeA 只出现一次」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/lenIn/.test(seg), '长度那一行没有用 lenIn');
  /* 锁的是：「11a 长度用独立的 lenIn，rangeA 只出现一次」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/parseInt\(lenIn\.value/.test(code), 'gen(str) 没有读 lenIn');
});

t('11b 两个 input 是不同元素（用 data-role 标记）', () => {
  const code = stripComments(read('js/tools/dev.js'));
  /* 锁的是：「11b 两个 input 是不同元素（用 data-role 标记）」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/'data-role': 'num-min'/.test(code), 'rangeA 没有可辨识的标记');
  /* 锁的是：「11b 两个 input 是不同元素（用 data-role 标记）」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/'data-role': 'str-len'/.test(code), 'lenIn 没有可辨识的标记');
});

/* ==================== 12. 目标番茄数 ==================== */

done();
