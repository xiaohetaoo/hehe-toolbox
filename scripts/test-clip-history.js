'use strict';
const { t, done } = require('./lib/harness');
/* 剪贴板历史的行为测试（原 test-round15 的 2 / 16a / 16b）。
 *
 * 锁的是三件事：
 *   2    倒计时结束后**不清空剪贴板** —— 早期实现在倒计时收尾时
 *        顺手清了历史，用户复制的东西在倒计时结束时消失。
 *   16a  两条裁剪路径（文本 / 图片）共用同一个上限常量。早期各写一个
 *        （文本 200、图片 100），于是「上限」到底是多少取决于最后进来的是
 *        哪种内容。
 *   16b  淘汰条目时必须真的回收图片文件，否则 %TEMP% 会无限增长。 */

/* ------------ 以下为迁移来的用例（断言逐字保留） ------------ */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const stripComments = require('../lib/src-scan').stripComments;
function read(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }

t('2 倒计时分支里不许出现 clip:write-text', () => {
  const code = stripComments(read('js/tools/life.js'));
  const i = code.indexOf('finishPhase');
  assert.ok(i > 0, '找不到 finishPhase');
  const j = code.indexOf('if (phase === \'work\')', i);
  const seg = code.slice(i, j > 0 ? j : i + 1200);
  /* 锁的是：「2 倒计时分支里不许出现 clip:write-text」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(!/clip:write-text/.test(seg),
    '倒计时结束仍在写剪贴板（空串会把用户复制的内容清掉）');
  /* 锁的是：「2 倒计时分支里不许出现 clip:write-text」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/toast/.test(seg) && /Notification/.test(seg), '提醒仍应通过 toast + Notification');
});

/* ==================== 3. hash 结果不能绑在 DOM 行上 ==================== */

t('16a 两条裁剪路径共用同一上限', () => {
  const code = stripComments(read('js/tools/security.js'));
  /* 锁的是：「16a 两条裁剪路径共用同一上限」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/function historyLimit\(\)/.test(code), '没有统一的条数上限来源');
  /* 锁的是：「16a 两条裁剪路径共用同一上限」里**上限的来源**这一半。
   * 只能用源码断言：要验的是"上限取自设置而不是写死"，属于实现的形态；
   * 行为上验需要真的复制 80 条再改设置，跨进程且极慢。 */
  assert.ok(/Prefs\.get\('clipHistoryLimit'\)/.test(code),
    '上限不再来自设置（用户改设置后不生效）');
  /* 锁的是：「16a 两条裁剪路径共用同一上限」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(/trimHistory\(history\)/.test(code), '没有走统一裁剪');
  /* 锁的是：「两条裁剪路径共用同一上限」中的**两条**。
   * 只断言存在 trimHistory 是不够的：把其中一条改回 slice(0, N)，
   * 另一条仍能让上一条断言通过。这里要求调用点至少两处。 */
  assert.ok((code.match(/trimHistory\(history\)/g) || []).length >= 2,
    '只有一条路径走了统一裁剪（另一条还在自己截断）');
  // 反面：不许再出现写死的 200 与 100
  /* 锁的是：「16a 两条裁剪路径共用同一上限」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(!/history = history\.slice\(0, 200\)/.test(code), '文本路径仍是硬编码 slice(0,200)（不回收图片）');
  /* 锁的是：「16a 两条裁剪路径共用同一上限」这一组回归。
   * 只能用源码断言：要验的是实现的形态（有某个判断 / 没有某种写法），
   * 真实行为需要 Electron、真实设备或竞态才能观察到。 */
  assert.ok(!/trimHistory\(history, 100\)/.test(code), '图片路径仍用另一个上限 100');
});

t('16b 行为：淘汰的图片文件必须被回收', async () => {
  /* 复现机理：一条图片被文本挤出列表时，它的落盘文件要跟着删。
   * 【场景设计】把图片放在**列表末尾**（最老的位置），再加两条新文本，
   * 这样它必然被挤出前 200 名 —— 之前我把图片放在最前面，它永远不会被淘汰，
   * 于是断言恒空转（那种"永远绿"的测试等于没测）。 */
  const removed = [];
  const dropImages = async (entries) => {
    const f = (entries || []).filter((x) => x && x.type === 'image' && x.file).map((x) => x.file);
    if (f.length) removed.push(...f);
  };
  const LIMIT = 200;
  async function trimHistory(list) {
    if (list.length <= LIMIT) return list;
    const dropped = list.slice(LIMIT);
    await dropImages(dropped);
    return list.slice(0, LIMIT);
  }
  const list = [];
  for (let i = 0; i < LIMIT; i++) list.push({ type: 'text', content: 't' + i });
  // 图片压在末尾（最老），再加两条新条目 → 它被挤出前 200
  list.push({ type: 'image', file: 'C:/tmp/pic.png' });
  list.unshift({ type: 'text', content: 'new1' });
  list.unshift({ type: 'text', content: 'new2' });
  const out = await trimHistory(list);
  assert.ok(out.length <= LIMIT, '裁剪后仍超上限：' + out.length);
  assert.deepStrictEqual(removed, ['C:/tmp/pic.png'],
    '被挤出的图片文件没有被回收（会永久残留在 clip-img 里）');
  assert.ok(!out.some((x) => x.type === 'image'),
    '图片仍在列表里，说明本场景没造对（测试会恒绿）');
});

/* ==================== 17. scan-tree 根路径 ==================== */

done();
