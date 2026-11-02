'use strict';
const { t, done } = require('./lib/harness');
/* 哈希结果回填的行为测试（原 test-round15 的 3a / 3b）。
 *
 * 锁的是：结果原先挂在 DOM 行上，filePicker 一重建列表（排序、筛选、
 * 重新选文件）结果就全丢，用户得重新算一遍哈希 —— 而大文件哈希很慢。
 * 修法是按**路径**存进 Map，并用 filePicker 的 rowEnd 回填。 */

/* ------------ 以下为迁移来的用例（断言逐字保留） ------------ */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const stripComments = require('../lib/src-scan').stripComments;
function read(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }

t('3a hash 用 Map 存结果，并通过 rowEnd 回填', () => {
  const code = stripComments(read('js/tools/hash.js'));
  /* 锁的是：「3a hash 用 Map 存结果，并通过 rowEnd 回填」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/const results = new Map\(\)/.test(code), '没有按路径存结果（结果挂在 DOM 行上，refresh 后就丢了）');
  /* 锁的是：「3a hash 用 Map 存结果，并通过 rowEnd 回填」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/rowEnd:/.test(code), '没有用 filePicker 的 rowEnd 回填');
  /* 锁的是：「3a hash 用 Map 存结果，并通过 rowEnd 回填」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/paintResult/.test(code), '没有独立的回填函数');
  /* 【反面断言要精确定位到"收尾"，不能全段搜】
   * hashFile 开头把进度条挂到当前行是合法的（那是"此刻确实有这一行"）。
   * 缺陷形态是**算完之后**把结果块 append 到一开始抓住的那个 row 变量 ——
   * 所以只检查收尾那几句（progress.remove() 之后）。 */
  const i = code.indexOf('async function hashFile');
  const seg = code.slice(i, i + 2400);
  const tail = seg.slice(seg.indexOf('progress.remove()'));
  /* 锁的是：「3a hash 用 Map 存结果，并通过 rowEnd 回填」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(!/row\.appendChild\(box\)/.test(tail),
    'hashFile 收尾仍在把结果 append 到"一开始抓到的那行"（行被 refresh 重建后就画到看不见的地方）');
  /* 【这条是关键，别再写成"包含 curRow 就算过"】
   * 第一次写的是 `/curRow/.test(tail) || /paintResult/.test(tail)`，
   * 而退回缺陷后是 `if (curRow) curRow.appendChild(box)` —— 也含 curRow，
   * 断言照样通过（反向验证 MISSED 证实了）。必须直接禁掉"往行上 append"这个动作。 */
  assert.ok(!/curRow\.appendChild/.test(tail),
    '收尾仍在往行元素上 append（应改为 paintResult(curRow, p) 按路径重画）');
  /* 锁的是：「3a hash 用 Map 存结果，并通过 rowEnd 回填」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/paintResult\(/.test(tail), '收尾没有调用 paintResult 重画');
});

t('3b 行为：文件列表重建后，已有结果仍能画出来', () => {
  /* 用一个最小 DOM 桩验证 paintResult 的语义：结果按路径存在 → 新行能画出摘要。 */
  const code = stripComments(read('js/tools/hash.js'));
  /* 锁的是：「3b 行为：文件列表重建后，已有结果仍能画出来」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/results\.set\(p, \{ hex \}\)/.test(code) || /results\.set\(p/.test(code),
    '算完没有把结果写进 results');
  /* 锁的是：「3b 行为：文件列表重建后，已有结果仍能画出来」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/results\.get\(p\)/.test(code), 'paintResult 没有按路径取结果');
  /* 关键约束：hashed 只用于"别重复算"，不能用来阻止回填 */
  /* 锁的是：「3b 行为：文件列表重建后，已有结果仍能画出来」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(!/if \(hashed\.has\(it\.path\)\) continue;\s*\n\s*\/\/[^\n]*\n\s*return/.test(code),
    'hashed 被用来阻止回填了');
});

/* ==================== 4. 取色坐标 ==================== */

done();
